"""Guide Studio V1 API. All authoring writes require a signed session + workspace membership."""
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select, or_
from sqlalchemy.orm import Session

from server.auth import COOKIE, TTL, secret, hash_password, verify_password, make_session, require_user, check_origin
from server.db import Base, engine, SessionLocal, User, Workspace, Membership, Project, Guide, GuidePublication, FAQ, Asset, now
from server import storage

ROOT = Path(__file__).resolve().parents[1]


def seed():
    """Initialize a secure owner; credentials must be supplied by deployer."""
    email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
    password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
    with SessionLocal() as db:
        if db.scalar(select(User.id).limit(1)):
            return
        if not email or len(password) < 12:
            raise RuntimeError("Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (min 12 characters) in .env")
        owner = User(email=email, display_name=email.split("@")[0], password_hash=hash_password(password))
        workspace = Workspace(name="我的工作空间", slug="default")
        db.add_all([owner, workspace]); db.flush()
        db.add_all([Membership(workspace_id=workspace.id, user_id=owner.id, role="owner"),
                    Project(workspace_id=workspace.id, name="言序 · Yanxu", slug="yanxu", description="言序小程序操作教程")])
        db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    secret()
    Base.metadata.create_all(engine)
    seed()
    yield

app = FastAPI(title="Guide Studio API", version="0.1.0", lifespan=lifespan, docs_url="/api/docs", redoc_url=None)
app.mount("/static", StaticFiles(directory=ROOT / "web"), name="static")


def db_session():
    with SessionLocal() as db:
        yield db


def current_user(request: Request, db: Session = Depends(db_session)):
    return require_user(request, db)


def membership(db, user, workspace_id):
    member = db.scalar(select(Membership).where(Membership.workspace_id == workspace_id, Membership.user_id == user.id))
    if not member:
        raise HTTPException(404, "工作空间不存在或没有访问权限")
    return member


def access_project(db, user, project_id):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "项目不存在")
    return project, membership(db, user, project.workspace_id)


def access_guide(db, user, guide_id):
    guide = db.get(Guide, guide_id)
    if not guide:
        raise HTTPException(404, "教程不存在")
    project, member = access_project(db, user, guide.project_id)
    return guide, project, member


def guide_out(g, include_steps=False):
    return {"id": g.id, "projectId": g.project_id, "title": g.title, "description": g.description,
            "category": g.category, "audience": g.audience, "status": g.status, "slug": g.slug,
            "revision": g.revision, "stepCount": len(g.steps or []), "createdAt": g.created_at.isoformat(),
            "updatedAt": g.updated_at.isoformat(),
            **({"steps": g.steps or []} if include_steps else {})}


class Credentials(BaseModel):
    email: str
    password: str


@app.post("/api/auth/login")
def login(body: Credentials, request: Request, db: Session = Depends(db_session)):
    check_origin(request)
    email = body.email.lower().strip()
    user = db.scalar(select(User).where(User.email == email))
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "账号或密码错误")
    resp = Response(content='{"ok":true}', media_type="application/json")
    resp.set_cookie(COOKIE, make_session(user.id), httponly=True, secure=(request.url.scheme == "https"), samesite="lax", max_age=TTL, path="/")
    return resp


@app.post("/api/auth/logout")
def logout(request: Request):
    check_origin(request)
    response = Response(content='{"ok":true}', media_type="application/json")
    response.delete_cookie(COOKIE, path="/")
    return response


@app.get("/api/auth/me")
def me(user: User = Depends(current_user), db: Session = Depends(db_session)):
    memberships = db.scalars(select(Membership).where(Membership.user_id == user.id)).all()
    return {"id": user.id, "email": user.email, "name": user.display_name,
            "workspaces": [{"id": m.workspace_id, "role": m.role, "name": db.get(Workspace, m.workspace_id).name} for m in memberships]}


@app.get("/api/projects")
def projects(user: User = Depends(current_user), db: Session = Depends(db_session)):
    memberships = db.scalars(select(Membership).where(Membership.user_id == user.id)).all()
    ids = [m.workspace_id for m in memberships]
    if not ids:
        return []
    return [{"id": p.id, "name": p.name, "slug": p.slug, "workspaceId": p.workspace_id, "description": p.description}
            for p in db.scalars(select(Project).where(Project.workspace_id.in_(ids))).all()]


class ProjectInput(BaseModel):
    workspaceId: str
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)


@app.post("/api/projects", status_code=201)
def new_project(body: ProjectInput, request: Request, user: User = Depends(current_user), db: Session = Depends(db_session)):
    check_origin(request)
    m = membership(db, user, body.workspaceId)
    if m.role != "owner":
        raise HTTPException(403, "需要工作空间管理员权限")
    project = Project(workspace_id=body.workspaceId, name=body.name, description=body.description, slug=uuid4().hex[:12])
    db.add(project); db.commit()
    return {"id": project.id, "name": project.name}


class GuideInput(BaseModel):
    projectId: str
    title: str = Field(default="未命名教程", min_length=1, max_length=200)
    description: str = Field(default="", max_length=3000)
    category: str = Field(default="基础操作", max_length=100)
    audience: str = Field(default="全部用户", max_length=100)
    steps: list[dict[str, Any]] = Field(default_factory=list, max_length=60)
    revision: int | None = None


def verify_steps(db, project, steps):
    if len(steps) > 60:
        raise HTTPException(422, "每篇教程最多60个步骤")
    for step in steps:
        if len(str(step.get("description", ""))) > 5000:
            raise HTTPException(422, "步骤说明过长")
        if len(step.get("annotations", [])) > 150:
            raise HTTPException(422, "单张截图标注过多")
        for field in ("sourceAssetId", "publicAssetId"):
            aid = step.get(field)
            if aid:
                asset = db.get(Asset, aid)
                if not asset or asset.workspace_id != project.workspace_id or not asset.ready:
                    raise HTTPException(422, f"无效图片引用: {field}")
                if field == "sourceAssetId" and asset.kind != "source":
                    raise HTTPException(422, "原始素材类型不匹配")
                if field == "publicAssetId" and asset.kind != "export":
                    raise HTTPException(422, "公开素材必须是导出的平面图片")


@app.get("/api/guides")
def guides(project_id: str, user: User = Depends(current_user), db: Session = Depends(db_session)):
    access_project(db, user, project_id)
    items = db.scalars(select(Guide).where(Guide.project_id == project_id).order_by(Guide.updated_at.desc())).all()
    return [guide_out(item) for item in items]


@app.post("/api/guides", status_code=201)
def create_guide(body: GuideInput, request: Request, user: User = Depends(current_user), db: Session = Depends(db_session)):
    check_origin(request)
    project, m = access_project(db, user, body.projectId)
    if m.role not in ("owner", "editor"):
        raise HTTPException(403, "缺少编辑权限")
    verify_steps(db, project, body.steps)
    item = Guide(project_id=project.id, author_id=user.id, title=body.title, description=body.description,
                 category=body.category, audience=body.audience, steps=body.steps)
    db.add(item); db.commit()
    return guide_out(item, True)


@app.get("/api/guides/{guide_id}")
def get_guide(guide_id: str, user: User = Depends(current_user), db: Session = Depends(db_session)):
    item, _, _ = access_guide(db, user, guide_id)
    return guide_out(item, True)


@app.put("/api/guides/{guide_id}")
def update_guide(guide_id: str, body: GuideInput, request: Request, user: User = Depends(current_user), db: Session = Depends(db_session)):
    check_origin(request)
    guide, project, m = access_guide(db, user, guide_id)
    if m.role not in ("owner", "editor"):
        raise HTTPException(403, "缺少编辑权限")
    if project.id != body.projectId:
        raise HTTPException(422, "不能跨项目移动教程")
    if body.revision != guide.revision:
        raise HTTPException(409, "此教程已被其他人修改，请刷新后再编辑")
    verify_steps(db, project, body.steps)
    for key in ("title", "description", "category", "audience", "steps"):
        setattr(guide, key, getattr(body, key))
    # The publication snapshot remains public until explicitly republished.
    guide.revision += 1
    guide.updated_at = now()
    db.commit()
    return guide_out(guide, True)


@app.post("/api/guides/{guide_id}/publish")
def publish_guide(guide_id: str, request: Request, user: User = Depends(current_user), db: Session = Depends(db_session)):
    check_origin(request)
    guide, project, m = access_guide(db, user, guide_id)
    if m.role not in ("owner", "editor", "reviewer"):
        raise HTTPException(403, "缺少发布权限")
    if not guide.steps or any(not step.get("publicAssetId") for step in guide.steps):
        raise HTTPException(422, "每个步骤必须先上传脱敏后导出图片")
    verify_steps(db, project, guide.steps)
    pub = db.get(GuidePublication, guide.id)
    if not pub:
        pub = GuidePublication(guide_id=guide.id, title=guide.title, category=guide.category, audience=guide.audience)
        db.add(pub)
    pub.title, pub.description, pub.category, pub.audience = guide.title, guide.description, guide.category, guide.audience
    pub.steps = [{"id": s.get("id"), "description": s.get("description", ""), "publicAssetId": s.get("publicAssetId")} for s in guide.steps]
    pub.published_at = now()
    guide.status = "published"
    guide.published_at = now()
    guide.updated_at = now()
    db.commit()
    return {"url": os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/") + "/g/" + guide.slug, "slug": guide.slug}


@app.delete("/api/guides/{guide_id}", status_code=204)
def delete_guide(guide_id: str, request: Request, user: User = Depends(current_user), db: Session = Depends(db_session)):
    check_origin(request)
    guide, _, member = access_guide(db, user, guide_id)
    if member.role != "owner":
        raise HTTPException(403, "只有管理员可以删除教程")
    for item in db.scalars(select(FAQ).where(FAQ.guide_id == guide.id)).all():
        item.guide_id = None
    pub = db.get(GuidePublication, guide.id)
    if pub: db.delete(pub)
    db.delete(guide); db.commit()
    return Response(status_code=204)


class FAQInput(BaseModel):
    projectId: str
    question: str = Field(min_length=3, max_length=300)
    audience: str = Field(default="全部用户", max_length=100)
    category: str = Field(default="基础操作", max_length=100)
    guideId: str | None = None


@app.get("/api/faqs")
def faqs(project_id: str, user: User = Depends(current_user), db: Session = Depends(db_session)):
    access_project(db, user, project_id)
    entries = db.scalars(select(FAQ).where(FAQ.project_id == project_id).order_by(FAQ.created_at.desc())).all()
    return [{"id": f.id, "question": f.question, "audience": f.audience, "category": f.category, "guideId": f.guide_id} for f in entries]


@app.post("/api/faqs", status_code=201)
def new_faq(body: FAQInput, request: Request, user: User = Depends(current_user), db: Session = Depends(db_session)):
    check_origin(request)
    _, member = access_project(db, user, body.projectId)
    if member.role not in ("owner", "editor"):
        raise HTTPException(403, "缺少编辑权限")
    if body.guideId and (not (g := db.get(Guide, body.guideId)) or g.project_id != body.projectId):
        raise HTTPException(422, "关联教程不属于当前项目")
    f = FAQ(project_id=body.projectId, question=body.question, audience=body.audience, category=body.category, guide_id=body.guideId)
    db.add(f); db.commit()
    return {"id": f.id}


@app.delete("/api/faqs/{faq_id}", status_code=204)
def delete_faq(faq_id: str, request: Request, user: User = Depends(current_user), db: Session = Depends(db_session)):
    check_origin(request)
    f = db.get(FAQ, faq_id)
    if not f:
        raise HTTPException(404, "问题不存在")
    _, member = access_project(db, user, f.project_id)
    if member.role not in ("owner", "editor"):
        raise HTTPException(403, "缺少编辑权限")
    db.delete(f); db.commit()
    return Response(status_code=204)


class MemberInput(BaseModel):
    workspaceId: str
    email: str
    displayName: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=12, max_length=200)
    role: str = "editor"


@app.post("/api/members", status_code=201)
def create_member(body: MemberInput, request: Request, user: User = Depends(current_user), db: Session = Depends(db_session)):
    check_origin(request)
    if membership(db, user, body.workspaceId).role != "owner":
        raise HTTPException(403, "需要管理员权限")
    if body.role not in ("editor", "reviewer"):
        raise HTTPException(422, "无效角色")
    email = body.email.lower().strip()
    existing = db.scalar(select(User).where(User.email == email))
    if existing:
        if db.scalar(select(Membership).where(Membership.user_id == existing.id, Membership.workspace_id == body.workspaceId)):
            raise HTTPException(409, "此用户已加入工作空间")
        member_user = existing
    else:
        member_user = User(email=email, display_name=body.displayName, password_hash=hash_password(body.password))
        db.add(member_user); db.flush()
    db.add(Membership(workspace_id=body.workspaceId, user_id=member_user.id, role=body.role)); db.commit()
    return {"id": member_user.id}


ALLOWED_MIME = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


@app.post("/api/assets")
async def upload_asset(request: Request, workspace_id: str, kind: str = "source", user: User = Depends(current_user), db: Session = Depends(db_session)):
    check_origin(request)
    member = membership(db, user, workspace_id)
    if member.role not in ("owner", "editor"):
        raise HTTPException(403, "缺少图片上传权限")
    mime = request.headers.get("content-type", "").split(";")[0]
    if mime not in ALLOWED_MIME or kind not in ("source", "export"):
        raise HTTPException(415, "仅支持 PNG、JPEG、WebP")
    max_size = int(os.getenv("MAX_UPLOAD_MB", "20")) * 1024 * 1024
    if int(request.headers.get("content-length", "0") or "0") > max_size:
        raise HTTPException(413, "图片超过大小限制")
    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > max_size:
            raise HTTPException(413, "图片超过大小限制")
    raw = bytes(payload)
    magic = (mime == "image/png" and raw.startswith(b"\x89PNG\r\n\x1a\n")) or \
            (mime == "image/jpeg" and raw.startswith(b"\xff\xd8\xff")) or \
            (mime == "image/webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")
    if not magic:
        raise HTTPException(422, "无效图片文件")
    key = f"{workspace_id}/{uuid4().hex}{ALLOWED_MIME[mime]}"
    if storage.using_cos():
        storage.s3_client().put_object(Bucket=os.environ["COS_BUCKET"], Key=key, Body=raw, ContentType=mime)
    else:
        storage.save_local(key, raw)
    asset = Asset(workspace_id=workspace_id, uploaded_by=user.id, object_key=key, mime_type=mime, size_bytes=len(raw), kind=kind)
    db.add(asset); db.commit()
    return {"id": asset.id, "url": f"/api/assets/{asset.id}/content"}


def public_asset(db, asset_id):
    """Only published flattened exports can be read anonymously."""
    asset = db.get(Asset, asset_id)
    if not asset or asset.kind != "export":
        return False
    publications = db.scalars(select(GuidePublication).join(Guide, GuidePublication.guide_id == Guide.id)
        .join(Project, Guide.project_id == Project.id).where(Project.workspace_id == asset.workspace_id)).all()
    return any(step.get("publicAssetId") == asset_id for pub in publications for step in (pub.steps or []))


@app.get("/api/assets/{asset_id}/content")
def asset_content(asset_id: str, request: Request, db: Session = Depends(db_session)):
    asset = db.get(Asset, asset_id)
    if not asset:
        raise HTTPException(404, "图片不存在")
    uid = None
    try:
        from server.auth import read_session
        uid = read_session(request.cookies.get(COOKIE, ""))
    except Exception:
        pass
    permitted = bool(uid and db.scalar(select(Membership.id).where(Membership.user_id == uid, Membership.workspace_id == asset.workspace_id)))
    if not permitted and not public_asset(db, asset_id):
        raise HTTPException(404, "图片不存在")
    if storage.using_cos():
        return RedirectResponse(storage.presign_download(asset.object_key), status_code=302, headers={"Cache-Control": "private, max-age=60"})
    path = storage.local_path(asset.object_key)
    if not path.exists():
        raise HTTPException(404, "图片不存在")
    return FileResponse(path, media_type=asset.mime_type, headers={"Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff"})


@app.get("/api/public/{slug}")
def published_guide(slug: str, db: Session = Depends(db_session)):
    guide = db.scalar(select(Guide).where(Guide.slug == slug))
    pub = db.get(GuidePublication, guide.id) if guide else None
    if not pub:
        raise HTTPException(404, "教程不存在或尚未发布")
    # Only a flattened export is public, never source IDs or editable annotations.
    steps = [{"id": step.get("id"), "description": step.get("description", ""),
              "imageUrl": f"/api/assets/{step['publicAssetId']}/content"} for step in pub.steps or []]
    return {"title": pub.title, "description": pub.description, "category": pub.category,
            "audience": pub.audience, "steps": steps, "updatedAt": pub.published_at.isoformat()}


@app.get("/api/health")
def health():
    return {"ok": True, "service": "guide-studio"}


@app.get("/g/{slug}")
def public_page(slug: str):
    return FileResponse(ROOT / "web" / "index.html")


@app.get("/")
def index():
    return FileResponse(ROOT / "web" / "index.html")
