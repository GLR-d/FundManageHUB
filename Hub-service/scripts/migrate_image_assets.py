"""停服后升级图片登记表；默认不访问 OSS，不修改原有账号、头像或账单字段。"""

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path

from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import async_sessionmaker
from starlette.concurrency import run_in_threadpool

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import oss
from core.config import Settings, get_settings
from core.database import create_database_engine
from core.security import utcnow
from models import Fund, ImageAsset, User
from service.image_asset import IMAGE_GRACE_PERIOD
from service.image_urls import ImageUrls, ensure_image_config


async def migrate_image_assets(
    settings: Settings | None = None, *, scan_oss: bool = False, dry_run: bool = False,
) -> dict[str, int]:
    """幂等回填，原数据保持原样。scan_oss 仅额外登记旧上传，dry_run 完全只读。"""
    settings = settings or get_settings()
    # 先完成可选的只读云盘点，再打开回填事务，避免等待网络时长期持有数据库锁。
    scanned: list[str] = []
    if scan_oss:
        ensure_image_config(settings)
        scanned = await run_in_threadpool(oss.list_image_keys, settings)
    engine = create_database_engine(settings)
    stats = dict(created=0, updated=0, referenced=0, references=0, unreferenced=0, scanned=len(scanned), skipped=0)
    try:
        async with engine.connect() as connection:
            has_table = await connection.run_sync(lambda sync: inspect(sync).has_table("image_assets"))
        if not dry_run:
            async with engine.begin() as connection:
                # 仅创建新登记表，不对其他业务表执行 create_all 或 alter。
                await connection.run_sync(lambda sync: ImageAsset.__table__.create(sync, checkfirst=True))
            has_table = True

        factory = async_sessionmaker(bind=engine, expire_on_commit=False)
        async with factory() as session:
            async with session.begin():
                users = (await session.execute(select(User.id, User.avatar))).all()
                funds = (await session.execute(select(Fund.user_id, Fund.photo))).all()
                user_ids = {user.id for user in users}
                urls = {user_id: ImageUrls(settings, user_id) for user_id in user_ids}
                references: Counter[str] = Counter()
                owners: dict[str, int] = {}
                for user_id, value in [*users, *funds]:
                    # 同一账单重复保存的图片仍只有一个引用；不同账单分别累计。
                    keys = {key for part in value.split(",") if (key := urls[user_id].object_key(part))}
                    references.update(keys)
                    owners.update({key: user_id for key in keys})
                for key in scanned:
                    match = oss.MANAGED_IMAGE_KEY.fullmatch(key)
                    if match is None or (user_id := int(match.group(1))) not in user_ids:
                        stats["skipped"] += 1
                        continue
                    owners[key] = user_id

                existing: dict[str, ImageAsset] = {}
                if has_table:
                    statement = select(ImageAsset).where(ImageAsset.bucket == settings.oss_bucket)
                    if not dry_run:
                        statement = statement.order_by(ImageAsset.object_key).with_for_update()
                    existing = {asset.object_key: asset for asset in await session.scalars(statement)}
                stats["referenced"] = len(references)
                stats["references"] = sum(references.values())
                now = utcnow()
                for key in sorted(existing.keys() | owners.keys()):
                    asset = existing.get(key)
                    count = references[key]
                    if count == 0:
                        stats["unreferenced"] += 1
                    if asset is None:
                        stats["created"] += 1
                        if not dry_run:
                            session.add(ImageAsset(
                                bucket=settings.oss_bucket, object_key=key, user_id=owners[key],
                                reference_count=count,
                                cleanup_after=None if count else now + IMAGE_GRACE_PERIOD,
                                deleting=False,
                            ))
                        continue
                    if key in owners and asset.user_id != owners[key]:
                        raise RuntimeError("Image registry owner is inconsistent")
                    if asset.deleting and count:
                        # 不能把已经开始删除的对象复活成可引用图片。
                        raise RuntimeError("A referenced image is already marked for deletion")
                    cleanup_after = None if count else asset.cleanup_after or now + IMAGE_GRACE_PERIOD
                    if asset.reference_count != count or asset.cleanup_after != cleanup_after:
                        stats["updated"] += 1
                        if not dry_run:
                            asset.reference_count = count
                            asset.cleanup_after = cleanup_after
        return stats
    finally:
        await engine.dispose()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scan-oss", action="store_true", help="只读盘点旧的托管图片，并登记不存在用户以外的对象")
    parser.add_argument("--dry-run", action="store_true", help="只输出待迁移计数，不创建表或写入数据")
    arguments = parser.parse_args()
    try:
        stats = await migrate_image_assets(scan_oss=arguments.scan_oss, dry_run=arguments.dry_run)
    except Exception as error:
        # 不输出可能包含 SDK URL 或凭据的异常正文。
        raise SystemExit(f"图片登记迁移失败 ({type(error).__name__})") from None
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
