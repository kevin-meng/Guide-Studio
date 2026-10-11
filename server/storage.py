"""Local storage + Tencent COS S3-compatible private bucket abstraction."""
import os
from pathlib import Path

LOCAL_ROOT = Path(os.getenv("LOCAL_UPLOAD_DIR", "./data/uploads"))


def using_cos():
    return os.getenv("STORAGE_BACKEND", "local") == "cos"


def s3_client():
    import boto3
    from botocore.config import Config
    region = os.getenv("COS_REGION", "ap-shanghai")
    endpoint = os.getenv("COS_ENDPOINT") or f"https://cos.{region}.myqcloud.com"
    return boto3.client("s3", region_name=region, endpoint_url=endpoint,
                        aws_access_key_id=os.getenv("COS_ACCESS_KEY_ID"),
                        aws_secret_access_key=os.getenv("COS_SECRET_ACCESS_KEY"),
                        aws_session_token=os.getenv("COS_SESSION_TOKEN") or None,
                        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))


def presign_upload(key, mime):
    return s3_client().generate_presigned_url("put_object", Params={"Bucket": os.environ["COS_BUCKET"], "Key": key, "ContentType": mime}, ExpiresIn=600)


def presign_download(key):
    return s3_client().generate_presigned_url("get_object", Params={"Bucket": os.environ["COS_BUCKET"], "Key": key}, ExpiresIn=300)


def save_local(key, payload):
    target = LOCAL_ROOT / key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload)


def local_path(key):
    return LOCAL_ROOT / key
