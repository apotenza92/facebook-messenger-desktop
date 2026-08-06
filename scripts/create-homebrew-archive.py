#!/usr/bin/env python3
import argparse
import gzip
import tarfile
from pathlib import Path


def create(source: Path, output: Path) -> None:
    paths = [source / "manifest.json", source / "SHA256SUMS", *sorted((source / "Casks").glob("*.rb"))]
    with output.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w") as archive:
        for path in paths:
            info = archive.gettarinfo(str(path), arcname=str(path.relative_to(source)))
            info.mtime = 0; info.uid = 0; info.gid = 0; info.uname = ""; info.gname = ""; info.mode = 0o644
            with path.open("rb") as stream: archive.addfile(info, stream)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("source", type=Path); parser.add_argument("output", type=Path); args = parser.parse_args()
    create(args.source, args.output)
