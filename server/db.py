"""Database models. SQLite is convenient for solo local dev; production uses PostgreSQL."""
import os
import uuid
from datetime import datetime, timezone
from sqlalchemy import create_engine, String, Text, Integer, ForeignKey, DateTime, UniqueConstraint, JSON, Boolean
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker


def uid():
    return str(uuid.uuid4())


def now():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Workspace(Base):
    __tablename__ = "workspaces"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(120))
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(20), default="editor")  # owner / editor / reviewer


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    slug: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(Text, default="")
    __table_args__ = (UniqueConstraint("workspace_id", "slug"),)


class Guide(Base):
    __tablename__ = "guides"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(200), default="未命名教程")
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(100), default="基础操作")
    audience: Mapped[str] = mapped_column(String(100), default="全部用户")
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft / published
    slug: Mapped[str] = mapped_column(String(100), unique=True, default=uid)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    steps: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class GuidePublication(Base):
    """Immutable public snapshot until the next explicit publish action."""
    __tablename__ = "guide_publications"
    guide_id: Mapped[str] = mapped_column(ForeignKey("guides.id"), primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(100))
    audience: Mapped[str] = mapped_column(String(100))
    steps: Mapped[list] = mapped_column(JSON, default=list)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class FAQ(Base):
    __tablename__ = "faqs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    question: Mapped[str] = mapped_column(String(300))
    audience: Mapped[str] = mapped_column(String(100), default="全部用户")
    category: Mapped[str] = mapped_column(String(100), default="基础操作")
    guide_id: Mapped[str | None] = mapped_column(ForeignKey("guides.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Asset(Base):
    __tablename__ = "assets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    uploaded_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    object_key: Mapped[str] = mapped_column(String(300), unique=True)
    mime_type: Mapped[str] = mapped_column(String(50))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(20), default="source")
    ready: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


def make_engine():
    url = os.getenv("DATABASE_URL", "sqlite:///./data/guide-studio.db")
    if url.startswith("sqlite:///"):
        dbpath = url.removeprefix("sqlite:///")
        if dbpath != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(dbpath)), exist_ok=True)
    return create_engine(url, connect_args={"check_same_thread": False} if url.startswith("sqlite") else {}, pool_pre_ping=True)

engine = make_engine()
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
