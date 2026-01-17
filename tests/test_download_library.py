import json

from humblebundle_downloader.download_library import DownloadLibrary


###
# _should_download_file_type
###
def test_include_logic_has_values():
    dl = DownloadLibrary(
        "fake_library_path",
        ext_include=["pdf", "EPub"],
    )
    assert dl._should_download_file_type("pdf") is True
    assert dl._should_download_file_type("df") is False
    assert dl._should_download_file_type("ePub") is True
    assert dl._should_download_file_type("mobi") is False


def test_include_logic_empty():
    dl = DownloadLibrary(
        "fake_library_path",
        ext_include=[],
    )
    assert dl._should_download_file_type("pdf") is True
    assert dl._should_download_file_type("df") is True
    assert dl._should_download_file_type("EPub") is True
    assert dl._should_download_file_type("mobi") is True


def test_exclude_logic_has_values():
    dl = DownloadLibrary(
        "fake_library_path",
        ext_exclude=["pdf", "EPub"],
    )
    assert dl._should_download_file_type("pdf") is False
    assert dl._should_download_file_type("df") is True
    assert dl._should_download_file_type("ePub") is False
    assert dl._should_download_file_type("mobi") is True


def test_exclude_logic_empty():
    dl = DownloadLibrary(
        "fake_library_path",
        ext_exclude=[],
    )
    assert dl._should_download_file_type("pdf") is True
    assert dl._should_download_file_type("df") is True
    assert dl._should_download_file_type("EPub") is True
    assert dl._should_download_file_type("mobi") is True


###
# _should_download_platform
###
def test_download_platform_filter_none():
    dl = DownloadLibrary(
        "fake_library_path",
        platform_include=None,
    )
    assert dl._should_download_platform("ebook") is True
    assert dl._should_download_platform("audio") is True


def test_download_platform_filter_blank():
    dl = DownloadLibrary(
        "fake_library_path",
        platform_include=[],
    )
    assert dl._should_download_platform("ebook") is True
    assert dl._should_download_platform("audio") is True


def test_download_platform_filter_audio():
    dl = DownloadLibrary(
        "fake_library_path",
        platform_include=["audio"],
    )
    assert dl._should_download_platform("ebook") is False
    assert dl._should_download_platform("audio") is True


def test_audit_local_file_updates_cache(tmp_path, monkeypatch):
    library_path = tmp_path / "library"
    library_path.mkdir()
    cache_file = library_path / ".cache.json"
    file_path = library_path / "bundle" / "item.pdf"
    file_path.parent.mkdir()
    file_path.write_text("content")

    dl = DownloadLibrary(str(library_path))
    dl.cache_file = str(cache_file)
    dl.cache_data = {}

    monkeypatch.setattr(
        dl, "_get_remote_last_modified", lambda remote_url: "Mon, 01 Jan 2024 00:00:00 GMT"
    )

    dl._audit_local_file(
        "order:file.pdf",
        str(file_path),
        remote_url="https://example.com/file.pdf",
    )

    assert dl.cache_data["order:file.pdf"]["url_last_modified"] == (
        "Mon, 01 Jan 2024 00:00:00 GMT"
    )
    with open(cache_file, "r") as cache_handle:
        cache_json = json.load(cache_handle)
    assert "order:file.pdf" in cache_json


def test_audit_local_file_missing_skips_cache(tmp_path):
    library_path = tmp_path / "library"
    library_path.mkdir()
    cache_file = library_path / ".cache.json"
    dl = DownloadLibrary(str(library_path))
    dl.cache_file = str(cache_file)
    dl.cache_data = {}

    dl._audit_local_file(
        "order:file.pdf",
        str(library_path / "missing.pdf"),
        remote_url="https://example.com/file.pdf",
    )

    assert dl.cache_data == {}
    assert cache_file.exists() is False
