import os
import sys
import logging
import argparse

logger = logging.getLogger(__name__)

LOG_LEVEL = os.environ.get("HBD_LOGLEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(message)s",
)
# Ignore unwanted logs from the requests lib when debuging
logging.getLogger("urllib3.connectionpool").setLevel(logging.WARNING)


def _add_common_args(
    parser, include_update=True, include_progress=True, include_offline=False
):
    cookie = parser.add_mutually_exclusive_group(required=True)
    cookie.add_argument(
        "-c",
        "--cookie-file",
        type=str,
        help="Location of the cookies file",
    )
    cookie.add_argument(
        "-s",
        "--session-auth",
        type=str,
        help="Value of the cookie _simpleauth_sess. WRAP IN QUOTES",
    )
    parser.add_argument(
        "-l",
        "--library-path",
        type=str,
        help="Folder to download all content to",
        required=True,
    )
    parser.add_argument(
        "-t",
        "--trove",
        action="store_true",
        help="Only check and download Humble Trove content",
    )
    if include_update:
        parser.add_argument(
            "-u",
            "--update",
            action="store_true",
            help=(
                "Check to see if products have been updated "
                "(still get new products)"
            ),
        )
    parser.add_argument(
        "-p",
        "--platform",
        type=str,
        nargs="*",
        help=(
            "Only get content in a platform. Values can be seen in your "
            "humble bundle's library dropdown. Ex: -p ebook video"
        ),
    )
    if include_progress:
        parser.add_argument(
            "--progress",
            action="store_true",
            help="Display progress bar for downloads",
        )
    filter_ext = parser.add_mutually_exclusive_group()
    filter_ext.add_argument(
        "-e",
        "--exclude",
        type=str,
        nargs="*",
        help=("File extensions to ignore when downloading files. " "Ex: -e pdf mobi"),
    )
    filter_ext.add_argument(
        "-i",
        "--include",
        type=str,
        nargs="*",
        help="Only download files with these extensions. Ex: -i pdf mobi",
    )
    parser.add_argument(
        "-k",
        "--keys",
        type=str,
        nargs="*",
        help=(
            "The purchase download key. Find in the url on the "
            "products/bundle download page. Can set multiple"
        ),
    )
    if include_offline:
        parser.add_argument(
            "--offline",
            action="store_true",
            help="Skip remote metadata lookups when auditing",
        )


def parse_args(args):
    if len(args) > 0 and args[0].lower() == "download":
        args = args[1:]
        raise DeprecationWarning("`download` argument is no longer used")

    parser = argparse.ArgumentParser()
    _add_common_args(parser)
    parser.set_defaults(command="download")

    subparsers = parser.add_subparsers(dest="command")
    audit_parser = subparsers.add_parser(
        "audit",
        help="Rebuild the cache from existing files without downloading",
    )
    _add_common_args(
        audit_parser,
        include_update=False,
        include_progress=False,
        include_offline=True,
    )
    audit_parser.set_defaults(command="audit")

    return parser.parse_args(args)


def cli():
    cli_args = parse_args(sys.argv[1:])

    from .download_library import DownloadLibrary

    DownloadLibrary(
        cli_args.library_path,
        cookie_path=cli_args.cookie_file,
        cookie_auth=cli_args.session_auth,
        progress_bar=getattr(cli_args, "progress", False),
        ext_include=cli_args.include,
        ext_exclude=cli_args.exclude,
        platform_include=cli_args.platform,
        purchase_keys=cli_args.keys,
        trove=cli_args.trove,
        update=getattr(cli_args, "update", False),
        audit=cli_args.command == "audit",
        offline=getattr(cli_args, "offline", False),
    ).start()
