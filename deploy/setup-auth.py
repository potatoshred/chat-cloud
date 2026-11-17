#!/usr/bin/env python3
"""Create a single-user login config without exposing the password to shell history."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
from urllib.parse import urlsplit


def create_config(origin, username, password):
    url = urlsplit(origin)
    if (url.scheme not in {"https", "http"} or not url.hostname or url.username or url.password
            or url.path or url.query or url.fragment
            or (url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1", "::1"})):
        raise ValueError("站点地址需为 https://域名（末尾不要加 /）；HTTP 仅允许 localhost 或回环地址。")
    if not re.fullmatch(r"[a-zA-Z0-9_.@-]{1,64}", username):
        raise ValueError("账号需为 1–64 位字母、数字或 _.@-。")
    if len(password) < 14 or len(password.encode("utf-16-le")) // 2 > 256:
        raise ValueError("密码长度需为 14–256 个字符，建议使用密码管理器生成。")
    hostname = url.hostname.encode('idna').decode('ascii')
    host = f"[{hostname}]" if ':' in hostname else hostname
    port = url.port
    if port is not None and port != {"https": 443, "http": 80}[url.scheme]:
        host += f":{port}"
    origin = f"{url.scheme}://{host}"
    salt = secrets.token_bytes(32)
    key = hashlib.scrypt(password.encode(), salt=salt, n=65536, r=8, p=2,
                         maxmem=128 * 1024 * 1024, dklen=64)
    return {"origin": origin, "username": username,
            "passwordHash": f"scrypt$65536$8$2${salt.hex()}${key.hex()}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True, help="例如 https://chat.example.com 或 http://localhost:8090")
    parser.add_argument("--username", default="admin")
    parser.add_argument("--force", action="store_true", help="替换现有配置（重启 auth 后生效）")
    args = parser.parse_args()
    target = Path(__file__).resolve().parent.parent / "secrets" / "auth.json"
    if target.exists() and not args.force:
        parser.error("secrets/auth.json 已存在；修改密码或地址请加 --force。")
    password = getpass.getpass("登录密码（至少 14 个字符）：")
    if password != getpass.getpass("再次输入密码："):
        parser.error("两次密码不一致。")
    try:
        config = create_config(args.origin, args.username, password)
    except ValueError as error:
        parser.error(str(error))
    target.parent.mkdir(mode=0o700, exist_ok=True)
    os.chmod(target.parent, 0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(config, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            os.fchmod(stream.fileno(), 0o600)
        os.replace(temporary, target)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    print(f"已创建 {target}，账号：{args.username}。明文密码未写入文件。")
    print(f"站点地址：{config['origin']}")
    if os.getuid() != 1000 or os.getgid() != 1000:
        print(f"运行 Compose 时需设置 AUTH_UID={os.getuid()} AUTH_GID={os.getgid()}，以读取当前用户拥有的配置。")
    print("启动：docker compose up -d --build")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        raise SystemExit("\n已取消。")
