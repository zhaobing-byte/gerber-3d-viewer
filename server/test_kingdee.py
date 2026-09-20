import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import server.kingdee_server as kingdee_server_module
from server.kingdee_api import material_filter, rows_to_materials
from server.kingdee_server import (
    AUTO_CATEGORY_KEY,
    MAX_IMPORT_BYTES,
    footprint_category_dir,
    import_size_limit,
    is_package_filename,
    list_footprint_models,
    merge_config,
    model_filename,
    model_source_path,
    public_config,
    read_config,
    resolve_model_source_path,
    store_footprint_archive,
    store_footprint_model,
    write_config,
)


class ConfigStoreTests(unittest.TestCase):
    def setUp(self):
        self.existing = {
            "base_url": "https://old.example/K3Cloud/",
            "dbid": "old-db",
            "username": "old-user",
            "appid": "old-app",
            "app_secret": "keep-me",
            "protocol": "v4",
            "lcid": "2052",
            "org_number": "100",
        }

    def test_blank_secret_preserves_existing_value(self):
        result = merge_config(self.existing, {"app_secret": ""})
        self.assertEqual(result["app_secret"], "keep-me")

    def test_public_config_never_returns_secret(self):
        result = public_config(self.existing)
        self.assertNotIn("app_secret", result)
        self.assertTrue(result["has_app_secret"])

    def test_write_and_read_config_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            write_config(self.existing, path)
            self.assertEqual(read_config(path), self.existing)


class MaterialQueryTests(unittest.TestCase):
    def test_filter_contains_electronic_material_prefixes_and_org(self):
        result = material_filter(org_number="100")
        for prefix in range(21, 30):
            self.assertIn(f"FNumber LIKE '{prefix}%'", result)
        self.assertIn("FUseOrgId.FNumber = '100'", result)

    def test_filter_escapes_quotes(self):
        result = material_filter("A'B", "1'00")
        self.assertIn("A''B", result)
        self.assertIn("1''00", result)

    def test_rows_are_mapped_to_named_materials(self):
        materials = rows_to_materials(
            [[1, "210001", "IC|MCU|TEST|QFN-20", "", "21", "IC", "PCS", "C", "A"]]
        )
        self.assertEqual(materials[0]["number"], "210001")
        self.assertEqual(materials[0]["name"], "IC|MCU|TEST|QFN-20")


class FootprintImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.category = "电容_贴片.3dshapes"
        (self.root / self.category).mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def test_category_must_be_existing_direct_child(self):
        for category in ("", "..", "../server", "a/b", "不存在.3dshapes"):
            with self.subTest(category=category):
                with self.assertRaises(ValueError):
                    footprint_category_dir(category, self.root)

    def test_filename_rejects_unsafe_or_unsupported_values(self):
        for filename in ("", "..", "a/b.step", "..\\x.step", "model.stl", "C_0603_L.txt", f"{'x' * 121}.step"):
            with self.subTest(filename=filename):
                with self.assertRaises(ValueError):
                    model_filename(filename)

    def test_filename_accepts_supported_suffixes_and_trims_space(self):
        self.assertEqual(model_filename(" C_0603_L.STEP "), "C_0603_L.STEP")
        self.assertEqual(model_filename("a.stp"), "a.stp")
        self.assertEqual(model_filename("a.glb"), "a.glb")

    def test_store_reports_stable_model_source_path(self):
        result = store_footprint_model(self.category, "C_0603_L.step", b"solid", self.root)
        self.assertEqual(result["source_path"], f"/footprint/3dmodels/{self.category}/C_0603_L.step")
        self.assertEqual(result["category"], self.category)
        self.assertFalse(result["overwritten"])
        self.assertFalse(result["requires_restart"])
        self.assertEqual((self.root / self.category / "C_0603_L.step").read_bytes(), b"solid")

    def test_store_overwrites_existing_model_and_leaves_no_temp_file(self):
        target = self.root / self.category / "C_0603_L.step"
        target.write_bytes(b"old")
        result = store_footprint_model(self.category, "C_0603_L.step", b"new", self.root)
        self.assertTrue(result["overwritten"])
        self.assertEqual(target.read_bytes(), b"new")
        self.assertEqual(sorted(path.name for path in (self.root / self.category).iterdir()), [target.name])

    def test_store_rejects_empty_and_oversized_payload(self):
        with self.assertRaises(ValueError):
            store_footprint_model(self.category, "a.step", b"", self.root)
        with self.assertRaises(ValueError):
            store_footprint_model(self.category, "a.step", b"x" * (MAX_IMPORT_BYTES + 1), self.root)


class FootprintCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "3dmodels"
        self.category = "电容_贴片.3dshapes"
        self.connector_category = "连接器_USB.3dshapes"
        (self.root / self.category).mkdir(parents=True)
        (self.root / self.connector_category).mkdir()
        (self.root / self.category / "C_0603_1608Metric.step").write_bytes(b"step")
        (self.root / self.category / "C_0603_1608Metric.glb").write_bytes(b"glb")
        (self.root / self.category / "说明.txt").write_text("ignore", encoding="utf-8")
        (self.root / self.connector_category / "USB-C.stp").write_bytes(b"stp")

    def tearDown(self):
        self.temporary.cleanup()

    def test_catalog_lists_supported_models_without_reading_other_files(self):
        rows = list_footprint_models(self.root)
        self.assertEqual([row["source_path"] for row in rows], [
            "/footprint/3dmodels/电容_贴片.3dshapes/C_0603_1608Metric.glb",
            "/footprint/3dmodels/电容_贴片.3dshapes/C_0603_1608Metric.step",
            "/footprint/3dmodels/连接器_USB.3dshapes/USB-C.stp",
        ])
        self.assertEqual(rows[1]["name"], "C_0603_1608Metric")
        self.assertEqual(rows[1]["extension"], ".step")
        self.assertEqual(rows[1]["bytes"], 4)
        self.assertIn("/api/footprint/model?path=", rows[1]["url"])

    def test_resolve_model_path_accepts_catalog_path_and_rejects_escape(self):
        source_path = model_source_path(self.category, "C_0603_1608Metric.step")
        self.assertEqual(
            resolve_model_source_path(source_path, self.root),
            self.root / self.category / "C_0603_1608Metric.step",
        )
        for invalid in (
            "/footprint/3dmodels/../server/config.json",
            "/footprint/3dmodels/电容_贴片.3dshapes/../C_0603_1608Metric.step",
            "/another-root/电容_贴片.3dshapes/C_0603_1608Metric.step",
        ):
            with self.subTest(source_path=invalid):
                with self.assertRaises(ValueError):
                    resolve_model_source_path(invalid, self.root)


class FootprintArchiveTests(unittest.TestCase):
    default_category = "电阻_贴片.3dshapes"
    matched_category = "电容_贴片.3dshapes"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.sandbox = Path(self.temporary.name)
        # 模型库与沙箱根分开一层，便于断言压缩包条目未刷到库目录之外。
        self.root = self.sandbox / "3dmodels"
        self.root.mkdir()
        (self.root / self.default_category).mkdir()
        (self.root / self.matched_category).mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def build_archive(self, entries: dict[str, bytes]) -> bytes:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as handle:
            for name, data in entries.items():
                handle.writestr(name, data)
        return buffer.getvalue()

    def stored(self, category: str) -> set[str]:
        return {path.name for path in (self.root / category).iterdir()}

    def test_size_limit_depends_on_upload_kind(self):
        self.assertTrue(is_package_filename("pack.ZIP"))
        self.assertFalse(is_package_filename("model.step"))
        self.assertGreater(import_size_limit("pack.zip"), import_size_limit("model.step"))

    def test_archive_routes_by_directory_and_creates_missing_categories(self):
        data = self.build_archive({
            # 命中的库内分类按目录名归位。
            f"厂家发布包/{self.matched_category}/R_0603_L.STEP": b"r",
            # 库内没有的 `<名>.3dshapes` 自动新建。
            "厂家发布包/新建_实验分类.3dshapes/C_0603_L.step": b"c",
            # 没有分类层级，落到所选分类。
            "厂家发布包/散装/misc.glb": b"g",
        })
        result = store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        self.assertEqual(result["kind"], "archive")
        self.assertEqual(result["written"], 3)
        self.assertEqual(result["skipped_count"], 0)
        self.assertEqual(result["created_categories"], ["新建_实验分类.3dshapes"])
        self.assertEqual(result["default_category"], self.default_category)
        self.assertEqual(self.stored(self.matched_category), {"R_0603_L.STEP"})
        self.assertEqual(self.stored("新建_实验分类.3dshapes"), {"C_0603_L.step"})
        self.assertEqual(self.stored(self.default_category), {"misc.glb"})
        self.assertEqual(
            {entry["category"] for entry in result["categories"]},
            {self.default_category, self.matched_category, "新建_实验分类.3dshapes"},
        )
        self.assertEqual(
            [entry["created_category"] for entry in result["models"] if entry["category"] == "新建_实验分类.3dshapes"],
            [True],
        )
        self.assertFalse(result["requires_restart"])

    def test_archive_reuses_one_new_category_for_all_its_entries(self):
        data = self.build_archive({
            "pack/新建_实验分类.3dshapes/A.step": b"a",
            "pack/新建_实验分类.3dshapes/sub/B.step": b"b",
        })
        result = store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        self.assertEqual(result["created_categories"], ["新建_实验分类.3dshapes"])
        self.assertEqual(self.stored("新建_实验分类.3dshapes"), {"A.step", "B.step"})

    def test_archive_rejects_invalid_new_category_names(self):
        data = self.build_archive({
            "pack/.3dshapes/A.step": b"a",
            "pack/非法*名.3dshapes/B.step": b"b",
            # 没有 `.3dshapes` 层级不是错误，落到所选分类。
            "pack/无分类层级/C.step": b"c",
        })
        result = store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        self.assertEqual(result["written"], 1)
        self.assertEqual(result["skipped_count"], 2)
        self.assertEqual(result["created_categories"], [])
        self.assertEqual(self.stored(self.default_category), {"C.step"})

    def test_archive_rejects_category_that_collides_with_a_file(self):
        (self.root / "冲突.3dshapes").write_bytes(b"not a directory")
        data = self.build_archive({"pack/冲突.3dshapes/A.step": b"a"})
        result = store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        self.assertEqual(result["written"], 0)
        self.assertEqual(result["skipped_count"], 1)
        self.assertEqual(result["created_categories"], [])
        self.assertEqual((self.root / "冲突.3dshapes").read_bytes(), b"not a directory")

    def test_archive_flattens_nested_subdirectories_into_category(self):
        data = self.build_archive({
            f"vendor/{self.matched_category}/step/3D/C_0603_L.step": b"c",
        })
        result = store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        self.assertEqual(result["written"], 1)
        self.assertEqual(result["models"][0]["source_path"],
                         f"/footprint/3dmodels/{self.matched_category}/C_0603_L.step")
        self.assertEqual(self.stored(self.matched_category), {"C_0603_L.step"})

    def test_archive_skips_unsupported_and_junk_entries(self):
        data = self.build_archive({
            "pack/C_0603_L.step": b"c",
            "pack/readme.txt": b"x",
            "pack/model.stl": b"x",
            "__MACOSX/._C_0603_L.step": b"x",
            "pack/Thumbs.db": b"x",
            "pack/~$C_0603_L.step": b"x",
        })
        result = store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        self.assertEqual(result["written"], 1)
        self.assertEqual(result["skipped_count"], 2)
        self.assertEqual(
            {entry["entry"] for entry in result["skipped"]},
            {"pack/readme.txt", "pack/model.stl"},
        )
        self.assertEqual(self.stored(self.default_category), {"C_0603_L.step"})

    def test_archive_rejects_path_traversal_without_writing_outside_root(self):
        data = self.build_archive({
            "../escaped.step": b"x",
            "pack/C_0603_L.step": b"c",
        })
        result = store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        self.assertEqual(result["written"], 1)
        self.assertEqual(result["skipped_count"], 1)
        self.assertEqual(result["skipped"][0]["reason"], "路径穿越")
        self.assertFalse((self.sandbox / "escaped.step").exists())
        self.assertEqual(self.stored(self.matched_category), set())

    def test_archive_counts_duplicate_targets_and_overwrites(self):
        existing = self.root / self.default_category / "C_0603_L.step"
        existing.write_bytes(b"old")
        data = self.build_archive({
            "a/C_0603_L.step": b"first",
            "b/C_0603_L.step": b"second",
        })
        result = store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        self.assertEqual(result["written"], 2)
        self.assertEqual(result["duplicate_names"], 1)
        self.assertEqual(result["overwritten"], 2)
        self.assertEqual(existing.read_bytes(), b"second")
        self.assertEqual(self.stored(self.default_category), {"C_0603_L.step"})

    def test_archive_requires_zip_name_and_existing_default_category(self):
        data = self.build_archive({"pack/C_0603_L.step": b"c"})
        with self.assertRaises(ValueError):
            store_footprint_archive(self.default_category, "pack.rar", data, self.root)
        with self.assertRaises(ValueError):
            store_footprint_archive("不存在.3dshapes", "pack.zip", data, self.root)

    def test_archive_rejects_corrupt_payload(self):
        with self.assertRaises(ValueError):
            store_footprint_archive(self.default_category, "pack.zip", b"not a zip", self.root)

    def test_archive_enforces_entry_and_extracted_size_limits(self):
        data = self.build_archive({
            "pack/a.step": b"aaa",
            "pack/b.step": b"bbb",
        })
        with patch.object(kingdee_server_module, "MAX_PACKAGE_ENTRIES", 1):
            with self.assertRaises(ValueError):
                store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        with patch.object(kingdee_server_module, "MAX_EXTRACTED_BYTES", 2):
            with self.assertRaises(ValueError):
                store_footprint_archive(self.default_category, "pack.zip", data, self.root)
        self.assertEqual(self.stored(self.default_category), set())


class FootprintAutoRouteTests(unittest.TestCase):
    """库为空时的「按包内分类自动归位」档位：不指定默认分类，从零重建分类目录。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        # 空库：一个分类目录都没有。
        self.root = Path(self.temporary.name) / "3dmodels"
        self.root.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def build_archive(self, entries: dict[str, bytes]) -> bytes:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as handle:
            for name, data in entries.items():
                handle.writestr(name, data)
        return buffer.getvalue()

    def test_auto_route_restores_library_from_empty_root(self):
        data = self.build_archive({
            "发布包/电阻_贴片.3dshapes/R_0603_L.step": b"r",
            "发布包/电容_贴片.3dshapes/sub/C_0603_L.step": b"c",
        })
        result = store_footprint_archive(AUTO_CATEGORY_KEY, "pack.zip", data, self.root)
        self.assertEqual(result["written"], 2)
        self.assertEqual(result["skipped_count"], 0)
        self.assertIsNone(result["default_category"])
        self.assertEqual(
            result["created_categories"],
            ["电容_贴片.3dshapes", "电阻_贴片.3dshapes"],
        )
        self.assertEqual(
            {path.name for path in (self.root / "电阻_贴片.3dshapes").iterdir()},
            {"R_0603_L.step"},
        )
        self.assertEqual(
            {path.name for path in (self.root / "电容_贴片.3dshapes").iterdir()},
            {"C_0603_L.step"},
        )

    def test_auto_route_skips_entries_without_category_layer(self):
        data = self.build_archive({
            "发布包/散装/misc.glb": b"g",
            "发布包/电阻_贴片.3dshapes/R_0603_L.step": b"r",
        })
        result = store_footprint_archive(AUTO_CATEGORY_KEY, "pack.zip", data, self.root)
        self.assertEqual(result["written"], 1)
        self.assertEqual(result["skipped_count"], 1)
        self.assertIn("未指定默认写入分类", result["skipped"][0]["reason"])
        # 跳过的条目不应留下任何目录。
        self.assertEqual(
            sorted(path.name for path in self.root.iterdir()),
            ["电阻_贴片.3dshapes"],
        )

    def test_auto_route_writes_nothing_when_archive_has_no_category_layer(self):
        data = self.build_archive({"发布包/散装/misc.glb": b"g"})
        result = store_footprint_archive(AUTO_CATEGORY_KEY, "pack.zip", data, self.root)
        self.assertEqual(result["written"], 0)
        self.assertEqual(result["skipped_count"], 1)
        self.assertEqual(result["created_categories"], [])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_auto_route_is_rejected_for_single_model_upload(self):
        with self.assertRaises(ValueError):
            store_footprint_model(AUTO_CATEGORY_KEY, "a.step", b"x", self.root)


if __name__ == "__main__":
    unittest.main()
