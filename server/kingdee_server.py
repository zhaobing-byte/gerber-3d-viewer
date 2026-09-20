#!/usr/bin/env python3
"""Local FABVIEW server with Kingdee configuration and material APIs."""

from __future__ import annotations

import argparse
import io
import json
import mimetypes
import os
import shutil
import tempfile
import time
import urllib.parse
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    from .kingdee_api import KingdeeAPIError, KingdeeClient, KingdeeCredentials
except ImportError:
    from kingdee_api import KingdeeAPIError, KingdeeClient, KingdeeCredentials


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
MAX_BODY_BYTES = 64 * 1024
FOOTPRINT_ROOT = PROJECT_ROOT / "footprint"
FOOTPRINT_MODEL_ROOT = FOOTPRINT_ROOT / "3dmodels"
# 人工绑定记录跟着工程走（与 library-manifest.json / 3dmodels-folder-map.csv 同级），
# 随 git 版本管理，不再只锁在某个浏览器的 localStorage 里。
MODEL_BINDINGS_PATH = FOOTPRINT_ROOT / "model-bindings.json"
MATERIAL_MATCHES_PATH = FOOTPRINT_ROOT / "material-matches.json"
STORE_VERSION = 1
MAX_STORE_BYTES = 4 * 1024 * 1024
# 路径 → (存储文件, JSON 里的字段名)。字段名就是前端读写的键名。
STORE_ROUTES: dict[str, tuple[Path, str]] = {
    "/api/kingdee/model-bindings": (MODEL_BINDINGS_PATH, "bindings"),
    "/api/kingdee/material-matches": (MATERIAL_MATCHES_PATH, "matches"),
}
ALLOWED_MODEL_SUFFIXES = frozenset({".step", ".stp", ".glb"})
ALLOWED_PACKAGE_SUFFIXES = frozenset({".zip"})
CATEGORY_SUFFIX = ".3dshapes"
MODEL_CATALOG_ROUTE = "/api/footprint/models"
MODEL_FILE_ROUTE = "/api/footprint/model"
MODEL_SOURCE_PREFIX = "/footprint/3dmodels/"
# 前端导入面板的「按包内分类自动归位」档位：不指定默认分类，完全按包内
# `<分类>.3dshapes/` 归位。库为空（一个分类目录都没有）时靠它完成从零恢复。
# 与前端 `footprintAutoCategory` 必须一致，改动要同步。
AUTO_CATEGORY_KEY = "__auto__"
MAX_IMPORT_BYTES = 80 * 1024 * 1024
# 压缩包按整包计上限；单个模型仍受 MAX_IMPORT_BYTES 约束。
# 与前端 `maxFootprintArchiveBytes` 必须一致，改动要同步。
MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
# 解压后总字节上限，防压缩炸弹。
# 需给 MAX_PACKAGE_BYTES 留出压缩比余量（STEP 文本约 5:1），否则整包过了会在解压阶段被拒。
MAX_EXTRACTED_BYTES = 8 * 1024 * 1024 * 1024
# 条目上限需与 MAX_EXTRACTED_BYTES 自洽：实测档案 0.44 MB/条目，8 GB 约合 1.8 万条，
# 旧的 20000 会先把“小模型为主”的合法包挡掉，故放宽到 40000。
MAX_PACKAGE_ENTRIES = 40000
# 报告里回传的明细条数上限，避免一次性把上万行塞给前端。
MAX_REPORTED_ROWS = 20
JUNK_FILE_NAMES = frozenset({"thumbs.db", "desktop.ini", ".ds_store"})
JUNK_DIR_NAMES = frozenset({"__macosx"})
INVALID_FILENAME_CHARS = frozenset('<>:"/\\|?*')
PUBLIC_FIELDS = (
    "base_url",
    "dbid",
    "username",
    "appid",
    "protocol",
    "lcid",
    "org_number",
)
DEFAULT_CONFIG: dict[str, Any] = {
    "base_url": "",
    "dbid": "",
    "username": "",
    "appid": "",
    "protocol": "v4",
    "lcid": "2052",
    "org_number": "100",
}


def read_config(path: Path = DEFAULT_CONFIG_PATH) -> dict[str, Any]:
    if not path.exists():
        return dict(DEFAULT_CONFIG)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"无法读取配置文件：{exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("配置文件必须是 JSON 对象")
    return {**DEFAULT_CONFIG, **value}


def public_config(config: dict[str, Any]) -> dict[str, Any]:
    result = {name: config.get(name, DEFAULT_CONFIG.get(name, "")) for name in PUBLIC_FIELDS}
    result["has_app_secret"] = bool(config.get("app_secret"))
    return result


def merge_config(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    result = dict(existing)
    for field in PUBLIC_FIELDS:
        if field in incoming:
            result[field] = str(incoming[field]).strip()
    secret = str(incoming.get("app_secret", ""))
    if secret:
        result["app_secret"] = secret

    required = ("base_url", "dbid", "username", "appid", "org_number")
    missing = [field for field in required if not result.get(field)]
    if missing:
        raise ValueError("请填写：" + "、".join(missing))
    if not result.get("app_secret"):
        raise ValueError("首次连接时需要填写 AppSecret")
    if result.get("protocol") not in {"v2", "v4"}:
        raise ValueError("登录协议只能是 v2 或 v4")
    if result.get("lcid") not in {"2052", "1033", "3076"}:
        raise ValueError("不支持该语言代码")
    if not result["base_url"].lower().startswith(("http://", "https://")):
        raise ValueError("服务地址必须以 http:// 或 https:// 开头")
    result["base_url"] = result["base_url"].rstrip("/") + "/"
    return result


def footprint_category_dir(category: str, root: Path = FOOTPRINT_MODEL_ROOT) -> Path:
    """校验分类目录名，返回模型库下已存在的一级目录。"""
    name = category.strip()
    if not name or name in {".", ".."} or name != Path(name).name:
        raise ValueError("分类目录名无效")
    if any(character in name for character in INVALID_FILENAME_CHARS):
        raise ValueError("分类目录名包含非法字符")
    resolved_root = root.resolve()
    directory = (resolved_root / name).resolve()
    try:
        directory.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError("分类目录名无效") from exc
    if not directory.is_dir():
        raise ValueError(f"分类目录不存在：{name}")
    return directory


def model_filename(filename: str) -> str:
    """校验并返回安全的模型文件名，拒绝路径分隔符与不支持的后缀。"""
    name = filename.strip()
    if not name or name in {".", ".."} or name != Path(name).name:
        raise ValueError("文件名无效")
    if any(character in name for character in INVALID_FILENAME_CHARS):
        raise ValueError("文件名包含非法字符")
    if len(name) > 120:
        raise ValueError("文件名过长")
    if Path(name).suffix.lower() not in ALLOWED_MODEL_SUFFIXES:
        raise ValueError("仅支持 .step / .stp / .glb 模型文件")
    return name


def model_source_path(category: str, filename: str) -> str:
    """返回前端绑定记录使用的稳定模型路径。"""
    return f"{MODEL_SOURCE_PREFIX}{category}/{filename}"


def resolve_model_source_path(source_path: str, root: Path = FOOTPRINT_MODEL_ROOT) -> Path:
    """把前端模型路径安全地解析为本机模型文件。

    模型库契约固定为 `<分类>.3dshapes/<文件>` 两级。路径校验在读取前完成，
    因此前端保存的绑定不能越出 `footprint/3dmodels`。
    """
    raw = source_path.strip().replace("\\", "/")
    if not raw.startswith(MODEL_SOURCE_PREFIX):
        raise ValueError("模型路径不属于本地 3D 封装库")
    relative = raw[len(MODEL_SOURCE_PREFIX):]
    parts = [part for part in relative.split("/") if part]
    if len(parts) != 2 or any(part in {".", ".."} for part in parts):
        raise ValueError("模型路径无效")
    category, filename = parts
    directory = footprint_category_dir(category, root)
    candidate = (directory / model_filename(filename)).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError("模型路径无效") from exc
    if not candidate.is_file():
        raise FileNotFoundError("模型文件不存在")
    return candidate


def model_file_url(source_path: str) -> str:
    """返回浏览器按需读取模型的本机 API 地址。"""
    return f"{MODEL_FILE_ROUTE}?{urllib.parse.urlencode({'path': source_path})}"


def list_footprint_models(root: Path = FOOTPRINT_MODEL_ROOT) -> list[dict[str, Any]]:
    """读取模型目录的轻量清单，不读取 STEP/GLB 文件内容。"""
    if not root.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    for category in sorted((entry for entry in root.iterdir() if entry.is_dir()), key=lambda entry: entry.name.casefold()):
        for model in sorted((entry for entry in category.iterdir() if entry.is_file()), key=lambda entry: entry.name.casefold()):
            suffix = model.suffix.lower()
            if suffix not in ALLOWED_MODEL_SUFFIXES:
                continue
            source_path = model_source_path(category.name, model.name)
            rows.append({
                "source_path": source_path,
                "name": model.stem,
                "extension": suffix,
                "bytes": model.stat().st_size,
                "url": model_file_url(source_path),
            })
    return rows


def store_footprint_model(
    category: str,
    filename: str,
    data: bytes,
    root: Path = FOOTPRINT_MODEL_ROOT,
) -> dict[str, Any]:
    """把模型字节原子写入分类目录，返回给前端的结果描述。"""
    if category.strip() == AUTO_CATEGORY_KEY:
        raise ValueError("单个模型导入必须指定分类目录")
    if not data:
        raise ValueError("模型内容为空")
    if len(data) > MAX_IMPORT_BYTES:
        raise ValueError(f"模型文件超过 {MAX_IMPORT_BYTES // (1024 * 1024)} MB 上限")
    directory = footprint_category_dir(category, root)
    name = model_filename(filename)
    target = directory / name
    overwritten = target.exists()
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{name}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        os.replace(temporary_name, target)
    except OSError:
        Path(temporary_name).unlink(missing_ok=True)
        raise
    return {
        "kind": "model",
        "category": directory.name,
        "filename": name,
        "source_path": model_source_path(directory.name, name),
        "bytes": len(data),
        "overwritten": overwritten,
        "requires_restart": False,
    }


def is_package_filename(filename: str) -> bool:
    """判断上传文件名是否为受支持的压缩包。"""
    return Path(filename.strip()).suffix.lower() in ALLOWED_PACKAGE_SUFFIXES


def import_size_limit(filename: str) -> int:
    """按上传类型返回体积上限，压缩包允许更大的整包体积。"""
    return MAX_PACKAGE_BYTES if is_package_filename(filename) else MAX_IMPORT_BYTES


def archive_category_lookup(root: Path = FOOTPRINT_MODEL_ROOT) -> dict[str, str]:
    """库内已有分类目录映射：小写目录名 -> 实际目录名。"""
    if not root.is_dir():
        return {}
    return {
        entry.name.lower(): entry.name
        for entry in root.iterdir()
        if entry.is_dir() and entry.name.lower().endswith(CATEGORY_SUFFIX)
    }


def package_entry_parts(info: zipfile.ZipInfo) -> list[str] | None:
    """规范化压缩包条目路径。目录与系统垃圾文件返回 None，非法路径抛 ValueError。"""
    if info.is_dir():
        return None
    name = info.filename.replace("\\", "/").strip()
    while name.startswith("./"):
        name = name[2:]
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if not parts:
        return None
    if parts[0].lower() in JUNK_DIR_NAMES or parts[-1].lower() in JUNK_FILE_NAMES:
        return None
    if parts[-1].startswith(("._", "~$")):
        return None
    if ".." in parts:
        raise ValueError("路径穿越")
    return parts


def new_category_dir_name(segment: str) -> str:
    """校验准备新建的分类目录段，返回可用的目录名。"""
    name = segment.strip()
    if not name or name in {".", ".."} or name != Path(name).name:
        raise ValueError("分类目录名无效")
    if any(character in name for character in INVALID_FILENAME_CHARS):
        raise ValueError("分类目录名包含非法字符")
    if name.startswith(".") or name.endswith((" ", ".")):
        raise ValueError("分类目录名不能以点开头或以空格/点结尾")
    if len(name) > 120:
        raise ValueError("分类目录名过长")
    if len(name) <= len(CATEGORY_SUFFIX) or not name.lower().endswith(CATEGORY_SUFFIX):
        raise ValueError(f"分类目录缺少 {CATEGORY_SUFFIX} 后缀")
    return name


def package_target(
    parts: list[str],
    lookup: dict[str, str],
    default_category: str | None,
) -> tuple[str | None, bool]:
    """智能归位：包内最近的 `<分类>.3dshapes/` 祖先段决定目标分类。

    该分类已存在则直接复用；库内没有则返回待新建的目录名（由调用方建目录）。
    没有 `.3dshapes` 祖先段的条目落到 `default_category`；`default_category` 为
    `None`（库为空时的「按包内分类自动归位」档位）时返回 `None`，由调用方跳过。
    返回值的第二项表示该分类目录需要新建。
    """
    for segment in reversed(parts[:-1]):
        if not segment.lower().endswith(CATEGORY_SUFFIX):
            continue
        known = lookup.get(segment.lower())
        if known:
            return known, False
        return new_category_dir_name(segment), True
    return default_category, False


def _open_archive(source: bytes | Path) -> zipfile.ZipFile:
    """打开字节或磁盘上的 ZIP，便于测试直接传字节。"""
    return zipfile.ZipFile(io.BytesIO(source) if isinstance(source, bytes) else Path(source))


def store_footprint_archive(
    category: str,
    filename: str,
    source: bytes | Path,
    root: Path = FOOTPRINT_MODEL_ROOT,
) -> dict[str, Any]:
    """把 ZIP 内的模型解压进分类目录，返回导入报告。

    - 包内最近的 `<分类>.3dshapes/` 祖先段决定目标分类：已存在则归位，
      库内没有则新建该分类目录（新目录未登记到 `src/footprint-categories.ts` 时，
      前端会回落到「其他」大类，不会报错）；没有该层级时落入 `category`。
    - `category` 为 `AUTO_CATEGORY_KEY` 时不指定默认分类，完全按包内分类归位，
      用于库为空时从零恢复；此时没有 `.3dshapes` 层级的条目被跳过并计入报告。
    - 深层子目录会被拍平，只保留文件名：库契约是 `<分类>.3dshapes/<模型>` 两级，
      便于本机模型目录按需扫描和安全地提供单个模型文件。
    - 非模型条目、系统垃圾与本库不接受的扩展名会被跳过并记入报告，不中断整包。
    - 落盘始终使用校验后的分类目录名 + 文件名，条目路径不参与拼接，从结构上排除 zip-slip。
    """
    started = time.perf_counter()
    archive_name = Path(filename.strip()).name
    if not is_package_filename(archive_name):
        raise ValueError("仅支持 .zip 压缩包")
    default_category = (
        None
        if category.strip() == AUTO_CATEGORY_KEY
        else footprint_category_dir(category, root).name
    )
    lookup = archive_category_lookup(root)

    written = 0
    overwritten = 0
    duplicates = 0
    skipped_count = 0
    skipped: list[dict[str, str]] = []
    per_category: dict[str, int] = {}
    models: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    created: set[str] = set()

    def reject(entry: str, reason: str) -> None:
        nonlocal skipped_count
        skipped_count += 1
        if len(skipped) < MAX_REPORTED_ROWS:
            skipped.append({"entry": entry, "reason": reason})

    try:
        with _open_archive(source) as handle:
            entries = handle.infolist()
            if len(entries) > MAX_PACKAGE_ENTRIES:
                raise ValueError(f"压缩包条目超过 {MAX_PACKAGE_ENTRIES} 个上限")
            extracted_bytes = sum(info.file_size for info in entries)
            if extracted_bytes > MAX_EXTRACTED_BYTES:
                raise ValueError(
                    f"解压后总大小超过 {MAX_EXTRACTED_BYTES // (1024 * 1024)} MB 上限"
                )
            for info in entries:
                try:
                    parts = package_entry_parts(info)
                except ValueError as exc:
                    reject(info.filename, str(exc))
                    continue
                if parts is None:
                    continue
                try:
                    name = model_filename(parts[-1])
                    if info.file_size > MAX_IMPORT_BYTES:
                        raise ValueError(
                            f"单个模型超过 {MAX_IMPORT_BYTES // (1024 * 1024)} MB 上限"
                        )
                    target_category, is_new = package_target(parts, lookup, default_category)
                    if target_category is None:
                        raise ValueError(
                            "包内没有 <分类>.3dshapes/ 层级，且未指定默认写入分类"
                        )
                    if is_new:
                        # 登记进 lookup，包内后续同目录条目直接复用同名分类。
                        lookup[target_category.lower()] = target_category
                    if (target_category, name) in seen:
                        duplicates += 1
                    seen.add((target_category, name))
                    target = root / target_category / name
                    existed = target.exists()
                    if not target.parent.is_dir():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        created.add(target_category)
                    with handle.open(info) as source_stream:
                        descriptor, temporary_name = tempfile.mkstemp(
                            prefix=f".{name}.", suffix=".tmp", dir=target.parent
                        )
                        try:
                            with os.fdopen(descriptor, "wb") as sink:
                                shutil.copyfileobj(source_stream, sink, 1024 * 1024)
                            os.replace(temporary_name, target)
                        except BaseException:
                            Path(temporary_name).unlink(missing_ok=True)
                            raise
                except (ValueError, OSError, RuntimeError, zipfile.BadZipFile) as exc:
                    reject(info.filename, str(exc))
                    continue
                written += 1
                overwritten += 1 if existed else 0
                per_category[target_category] = per_category.get(target_category, 0) + 1
                if len(models) < MAX_REPORTED_ROWS:
                    models.append({
                        "category": target_category,
                        "filename": name,
                        "source_path": model_source_path(target_category, name),
                        "bytes": info.file_size,
                        "overwritten": existed,
                        "created_category": is_new,
                    })
    except zipfile.BadZipFile as exc:
        raise ValueError("压缩包已损坏或不是有效的 ZIP 文件") from exc

    # 新建但一个文件也没写进去的分类目录是噪声，回滚掉。
    for name in sorted(created):
        directory = root / name
        try:
            if directory.is_dir() and not any(directory.iterdir()):
                directory.rmdir()
                created.discard(name)
        except OSError:
            pass

    return {
        "kind": "archive",
        "archive": archive_name,
        "default_category": default_category,
        "written": written,
        "overwritten": overwritten,
        "duplicate_names": duplicates,
        "skipped_count": skipped_count,
        "skipped": skipped,
        "created_categories": sorted(created),
        "categories": [
            {"category": name, "count": count}
            for name, count in sorted(per_category.items(), key=lambda item: (-item[1], item[0]))
        ],
        "models": models,
        "requires_restart": False,
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
    }


def write_json_file(path: Path, value: dict[str, Any]) -> None:
    """原子写：先写同目录临时文件再 replace，避免半截 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        temporary_path.replace(path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def write_config(config: dict[str, Any], path: Path = DEFAULT_CONFIG_PATH) -> None:
    write_json_file(path, config)


def read_string_map_store(path: Path, field: str) -> dict[str, Any]:
    """读一个 `<field>` 为字符串映射的 JSON 存储；文件不存在时返回空表。"""
    empty = {"version": STORE_VERSION, "updated_at": None, field: {}}
    if not path.exists():
        return empty
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"无法读取 {path.name}：{exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} 必须是 JSON 对象")
    raw = value.get(field, {})
    if not isinstance(raw, dict):
        raise ValueError(f"{path.name} 的 {field} 必须是 JSON 对象")
    entries = {
        key: item
        for key, item in raw.items()
        if isinstance(key, str) and key.strip() and isinstance(item, str) and item.strip()
    }
    return {
        "version": value.get("version", STORE_VERSION),
        "updated_at": value.get("updated_at"),
        field: entries,
    }


def write_string_map_store(path: Path, field: str, entries: dict[str, str]) -> dict[str, Any]:
    payload = {
        "version": STORE_VERSION,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        field: {key: entries[key] for key in sorted(entries)},
    }
    write_json_file(path, payload)
    return payload


def credentials_from_config(config: dict[str, Any]) -> KingdeeCredentials:
    return KingdeeCredentials(
        base_url=str(config["base_url"]),
        dbid=str(config["dbid"]),
        username=str(config["username"]),
        appid=str(config["appid"]),
        app_secret=str(config["app_secret"]),
        lcid=int(config.get("lcid", 2052)),
        org_number=str(config.get("org_number", "100")),
    )


class FabViewHandler(BaseHTTPRequestHandler):
    server_version = "FABVIEW/1.0"

    @property
    def config_path(self) -> Path:
        return self.server.config_path  # type: ignore[attr-defined]

    @property
    def static_dir(self) -> Path:
        return self.server.static_dir  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _send_json(self, value: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self, limit: int = MAX_BODY_BYTES) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("请求长度无效") from exc
        if length <= 0 or length > limit:
            raise ValueError("请求内容为空或过大")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求内容不是有效 JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("请求 JSON 必须是对象")
        return value

    def _read_store(self, path: Path, field: str) -> None:
        self._send_json(read_string_map_store(path, field))

    def _write_store(self, path: Path, field: str) -> None:
        payload = self._read_json(MAX_STORE_BYTES)
        raw = payload.get(field, {})
        if not isinstance(raw, dict):
            raise ValueError(f"{field} 必须是字符串映射对象")
        entries = {
            key: item
            for key, item in raw.items()
            if isinstance(key, str) and key.strip() and isinstance(item, str) and item.strip()
        }
        self._send_json(write_string_map_store(path, field, entries))

    def _saved_config(self) -> dict[str, Any]:
        config = read_config(self.config_path)
        missing = [
            field
            for field in ("base_url", "dbid", "username", "appid", "app_secret")
            if not config.get(field)
        ]
        if missing:
            raise ValueError("请先完成并保存金蝶连接配置")
        return config

    def _serve_static(self, request_path: str) -> None:
        relative = urllib.parse.unquote(request_path).lstrip("/") or "index.html"
        requested = (self.static_dir / relative).resolve()
        try:
            requested.relative_to(self.static_dir.resolve())
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not requested.is_file():
            requested = self.static_dir / "index.html"
        try:
            body = requested.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "请先运行 npm run build")
            return
        content_type = mimetypes.guess_type(requested.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Cache-Control",
            "no-cache" if requested.name == "index.html" else "public, max-age=31536000, immutable",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _serve_footprint_model(self, source_path: str) -> None:
        """按需发送单个模型，避免把完整模型库打进前端构建产物。"""
        path = resolve_model_source_path(source_path)
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        # 同一路径的模型可以被用户替换，不能让浏览器保留旧实体。
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with path.open("rb") as stream:
            shutil.copyfileobj(stream, self.wfile, 1024 * 1024)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == MODEL_CATALOG_ROUTE:
                self._send_json({"models": list_footprint_models()})
                return
            if parsed.path == MODEL_FILE_ROUTE:
                source_path = urllib.parse.parse_qs(parsed.query).get("path", [""])[0]
                self._serve_footprint_model(source_path)
                return
            if parsed.path in STORE_ROUTES:
                path, field = STORE_ROUTES[parsed.path]
                self._read_store(path, field)
                return
            if parsed.path == "/api/kingdee/config":
                self._send_json(public_config(read_config(self.config_path)))
                return
            if parsed.path == "/api/kingdee/materials":
                query = urllib.parse.parse_qs(parsed.query)
                page = int(query.get("page", ["1"])[0])
                page_size = int(query.get("page_size", ["100"])[0])
                search = query.get("search", [""])[0]
                if page < 1 or page_size not in {50, 100, 200} or len(search) > 100:
                    raise ValueError("查询分页参数无效")
                client = KingdeeClient(credentials_from_config(self._saved_config()))
                self._send_json(client.query_materials(page, page_size, search))
                return
            if parsed.path == "/api/kingdee/sync":
                started = time.perf_counter()
                client = KingdeeClient(credentials_from_config(self._saved_config()), timeout=45.0)
                items = client.query_all_materials()
                self._send_json({
                    "items": items,
                    "total": len(items),
                    "elapsed_ms": round((time.perf_counter() - started) * 1000),
                })
                return
            self._serve_static(parsed.path)
        except (ValueError, KingdeeAPIError) as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except FileNotFoundError as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)

    def _copy_body(self, sink: Any, length: int) -> None:
        """按块把请求体写入文件，长度不足时报错。"""
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise ValueError("上传中断，请重试")
            sink.write(chunk)
            remaining -= len(chunk)

    def _import_footprint(self, parsed: urllib.parse.ParseResult) -> None:
        query = urllib.parse.parse_qs(parsed.query)
        category = query.get("category", [""])[0]
        filename = query.get("filename", [""])[0]
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("请求长度无效") from exc
        if length <= 0:
            raise ValueError("请求内容为空")
        limit = import_size_limit(filename)
        if length > limit:
            raise ValueError(f"上传内容超过 {limit // (1024 * 1024)} MB 上限")
        if is_package_filename(filename):
            # 压缩包可能很大，先落临时文件再解压，避免整包驻留内存。
            descriptor, temporary_name = tempfile.mkstemp(suffix=".zip")
            temporary_path = Path(temporary_name)
            try:
                with os.fdopen(descriptor, "wb") as sink:
                    self._copy_body(sink, length)
                self._send_json(store_footprint_archive(category, filename, temporary_path))
            finally:
                temporary_path.unlink(missing_ok=True)
            return
        data = self.rfile.read(length)
        if len(data) != length:
            raise ValueError("模型上传中断，请重试")
        self._send_json(store_footprint_model(category, filename, data))

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path in STORE_ROUTES:
                path, field = STORE_ROUTES[parsed.path]
                self._write_store(path, field)
                return
            if parsed.path == "/api/footprint/import":
                self._import_footprint(parsed)
                return
            payload = self._read_json()
            if self.path == "/api/kingdee/config":
                config = merge_config(read_config(self.config_path), payload)
                write_config(config, self.config_path)
                self._send_json(public_config(config))
                return
            if self.path == "/api/kingdee/probe":
                config = merge_config(read_config(self.config_path), payload)
                started = time.perf_counter()
                client = KingdeeClient(credentials_from_config(config), timeout=15.0)
                sample = client.query_materials(1, 1)
                self._send_json({
                    "ok": True,
                    "elapsed_ms": round((time.perf_counter() - started) * 1000),
                    "material_access": len(sample["items"]) > 0,
                })
                return
            self._send_json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
        except (ValueError, KingdeeAPIError) as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except OSError as exc:
            self._send_json({"error": f"本地配置写入失败：{exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def main() -> None:
    mimetypes.add_type("application/wasm", ".wasm")
    mimetypes.add_type("model/gltf-binary", ".glb")
    mimetypes.add_type("application/step", ".step")
    mimetypes.add_type("application/step", ".stp")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--static-dir", type=Path, default=PROJECT_ROOT / "dist")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), FabViewHandler)
    server.static_dir = args.static_dir.resolve()  # type: ignore[attr-defined]
    server.config_path = args.config.resolve()  # type: ignore[attr-defined]
    print(f"FABVIEW：http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
