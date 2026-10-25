"""共享 Redis 资源测试：单个客户端、共享给 checkpointer、退出只关闭一次。"""

import unittest
from unittest.mock import patch

from core.redis_client import open_checkpointer, open_redis


class Client:
    def __init__(self):
        self.close_count = 0

    async def aclose(self):
        self.close_count += 1


class Saver:
    instances = []

    def __init__(self, *, redis_client):
        self.client = redis_client
        self.entered = False
        self.exited = False
        self.instances.append(self)

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *args):
        self.exited = True


class SharedRedisLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        Saver.instances = []

    async def test_external_client_is_shared_and_closed_only_by_outer_context(self):
        client = Client()
        with patch("core.redis_client.Redis.from_url", return_value=client) as factory, patch("core.redis_client.AsyncRedisSaver", Saver):
            async with open_redis("redis://unused.test/0") as shared:
                async with open_checkpointer("redis://unused.test/0", shared) as saver:
                    self.assertIs(shared, client)
                    self.assertIs(saver.client, client)
                    self.assertTrue(saver.entered)
                self.assertTrue(saver.exited)
                self.assertEqual(client.close_count, 0)
            self.assertEqual(client.close_count, 1)
            factory.assert_called_once()

    async def test_legacy_standalone_checkpointer_call_manages_its_single_client(self):
        client = Client()
        with patch("core.redis_client.Redis.from_url", return_value=client) as factory, patch("core.redis_client.AsyncRedisSaver", Saver):
            async with open_checkpointer("redis://unused.test/0") as saver:
                self.assertIs(saver.client, client)
            self.assertEqual(client.close_count, 1)
            factory.assert_called_once()

    async def test_error_during_use_still_closes_shared_client(self):
        client = Client()
        with patch("core.redis_client.Redis.from_url", return_value=client), patch("core.redis_client.AsyncRedisSaver", Saver):
            with self.assertRaisesRegex(RuntimeError, "synthetic failure"):
                async with open_redis("redis://unused.test/0") as shared:
                    async with open_checkpointer("redis://unused.test/0", shared):
                        raise RuntimeError("synthetic failure")
            self.assertEqual(client.close_count, 1)
            self.assertTrue(Saver.instances[0].exited)


if __name__ == "__main__":
    unittest.main()
