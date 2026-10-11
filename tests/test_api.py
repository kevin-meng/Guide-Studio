"""V1 security, publishing, optimistic revision, permissions and FAQ regression tests."""
import base64
import os
import tempfile
from pathlib import Path

# App engine is created at module import time; isolate tests from developer's DB.
TMP = tempfile.TemporaryDirectory(prefix="guide-studio-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{TMP.name}/test.db"
os.environ["LOCAL_UPLOAD_DIR"] = f"{TMP.name}/uploads"
os.environ["STORAGE_BACKEND"] = "local"
os.environ["SESSION_SECRET"] = "a-unit-test-secret-value-longer-than-32-bytes"
os.environ["BOOTSTRAP_ADMIN_EMAIL"] = "owner@example.com"
os.environ["BOOTSTRAP_ADMIN_PASSWORD"] = "StrongTestPass123!"

from fastapi.testclient import TestClient
from server.main import app

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/sHsAAAAASUVORK5CYII=")


def test_full_flow_and_public_privacy():
    with TestClient(app) as client:
        assert client.get('/api/health').status_code == 200
        assert client.get('/api/projects').status_code == 401
        assert client.post('/api/auth/login', json={"email":"owner@example.com","password":"wrong"}).status_code == 401
        assert client.post('/api/auth/login', json={"email":"owner@example.com","password":"StrongTestPass123!"}).status_code == 200
        assert client.cookies.get('gs_session')
        user = client.get('/api/auth/me').json()
        projects = client.get('/api/projects').json()
        assert projects[0]['slug'] == 'yanxu'
        project_id = projects[0]['id']; workspace_id = projects[0]['workspaceId']
        source = client.post(f'/api/assets?workspace_id={workspace_id}&kind=source', content=PNG, headers={'content-type':'image/png'}).json()['id']
        export = client.post(f'/api/assets?workspace_id={workspace_id}&kind=export', content=PNG, headers={'content-type':'image/png'}).json()['id']
        step = {"id":"s1","description":"打开会议","annotations":[{"type":"rect","x":0.1,"y":0.1,"w":0.2,"h":0.2}], "sourceAssetId":source,"publicAssetId":export}
        created = client.post('/api/guides', json={"projectId":project_id,"title":"如何导出议程","steps":[step]})
        assert created.status_code == 201, created.text
        guide = created.json(); guide_id=guide['id']; slug=guide['slug']
        assert client.get(f'/api/public/{slug}').status_code == 404
        pub = client.post(f'/api/guides/{guide_id}/publish')
        assert pub.status_code == 200, pub.text
        # Public read has ONLY the flattened exported image, no original asset.
        with TestClient(app) as anonymous:
            public = anonymous.get(f'/api/public/{slug}').json()
            assert public['title'] == '如何导出议程'
            assert 'annotations' not in str(public)
            assert source not in str(public)
            assert anonymous.get(f'/api/assets/{export}/content').status_code == 200
            assert anonymous.get(f'/api/assets/{source}/content').status_code == 404
            assert anonymous.get(f'/g/{slug}').status_code == 200
        # Draft changes may not modify the published immutable snapshot.
        updated=client.put(f'/api/guides/{guide_id}',json={"projectId":project_id,"title":"新版教程草稿","revision":1,"steps":[step]})
        assert updated.status_code == 200, updated.text
        assert client.get(f'/api/public/{slug}').json()['title'] == '如何导出议程'
        conflict=client.put(f'/api/guides/{guide_id}',json={"projectId":project_id,"title":"并发修改","revision":1,"steps":[step]})
        assert conflict.status_code == 409
        assert client.post(f'/api/guides/{guide_id}/publish').status_code == 200
        assert client.get(f'/api/public/{slug}').json()['title'] == '新版教程草稿'
        f=client.post('/api/faqs',json={"projectId":project_id,"question":"会议议程怎么导出？","guideId":guide_id})
        assert f.status_code == 201
        assert len(client.get('/api/faqs',params={"project_id":project_id}).json()) == 1
        assert client.delete('/api/faqs/'+f.json()['id']).status_code == 204
        # Origin validation protects cookie-authenticated writes.
        rejected = client.post('/api/guides',json={"projectId":project_id,"title":"bad"},headers={'Origin':'https://malicious.example'})
        assert rejected.status_code == 403


def test_bad_upload_and_membership():
    with TestClient(app) as client:
        client.post('/api/auth/login',json={"email":"owner@example.com","password":"StrongTestPass123!"})
        project=client.get('/api/projects').json()[0]
        w=project['workspaceId']
        assert client.post(f'/api/assets?workspace_id={w}',content=b'<script>oops</script>',headers={'content-type':'image/png'}).status_code == 422
        assert client.post('/api/members',json={"workspaceId":w,"email":"editor@example.com","displayName":"小编","password":"StrongEditorPass123!","role":"editor"}).status_code == 201
        client.post('/api/auth/logout')
        client.post('/api/auth/login',json={"email":"editor@example.com","password":"StrongEditorPass123!"})
        assert client.get('/api/projects').status_code == 200
        assert client.post('/api/projects',json={"workspaceId":w,"name":"Unauthorized"}).status_code == 403
        assert client.post('/api/guides',json={"projectId":project['id'],"title":"编辑者教程"}).status_code == 201


def test_timeline_metadata_round_trip_without_public_leak():
    with TestClient(app) as client:
        client.post('/api/auth/login',json={'email':'owner@example.com','password':'StrongTestPass123!'})
        project_id=client.get('/api/projects').json()[0]['id']
        annotated={'id':'s-timeline','description':'点击按钮',
            'annotations':[{'id':'circle-1','type':'circle','x':0.2,'y':0.2,'w':0.2,'h':0.1,'createdSeq':1,'createdAt':'2026-10-11T12:00:00Z'}],
            'timelineSource':'recorded','nextAnnotationSeq':1,'nextEventSeq':2,
            'presentation':{'schemaVersion':1,'durationMs':2700,'timelineSource':'manual','cues':[{'objectId':'circle-1','atMs':700,'durationMs':500,'effect':'draw'}]}}
        r=client.post('/api/guides',json={'projectId':project_id,'title':'时间线测试','steps':[annotated]})
        assert r.status_code==201,r.text
        gid=r.json()['id'];slug=r.json()['slug']
        saved=client.get(f'/api/guides/{gid}').json()['steps'][0]
        assert saved['annotations'][0]['id']=='circle-1'
        assert saved['presentation']['cues'][0]['objectId']=='circle-1'
        assert saved['nextAnnotationSeq']==1
        # Public endpoint must never reveal private editable annotation or video timeline metadata.
        assert client.get(f'/api/public/{slug}').status_code==404
