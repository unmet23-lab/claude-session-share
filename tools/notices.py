"""Regenerate dist/windows-x64/NOTICES.txt with the same Rust toolchain used to build the EXE."""
import json
import re
import subprocess
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = "x86_64-pc-windows-msvc"


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, encoding="utf-8").strip()


def normal_packages():
    meta = json.loads(run("cargo", "metadata", "--locked", "--offline", "--format-version", "1",
                          "--filter-platform", TARGET))
    graph = {n["id"]: n["deps"] for n in meta["resolve"]["nodes"]}
    root = meta["resolve"]["root"]
    pending, found = [root], set()
    while pending:
        current = pending.pop()
        if current in found:
            continue
        found.add(current)
        pending.extend(d["pkg"] for d in graph[current]
                       if any(k["kind"] is None for k in d["dep_kinds"]))
    packages = [p for p in meta["packages"] if p["id"] in found and p["id"] != root]
    return sorted(packages, key=lambda p: (p["name"], p["version"]))


class NoticeText(HTMLParser):
    """Retain the standard library distribution's notices, preformatted license texts and links."""
    def __init__(self):
        super().__init__()
        self.body = False
        self.parts = []
        self.href = ""

    def handle_starttag(self, tag, attrs):
        if tag == "body":
            self.body = True
        if self.body and tag == "a":
            self.href = dict(attrs).get("href", "")
        if self.body and tag in {"br", "p", "h1", "h2", "h3", "li", "pre", "summary"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "a" and self.href.startswith(("http://", "https://")):
            self.parts.append(f" <{self.href}>")
        if tag == "a":
            self.href = ""
        if tag == "body":
            self.body = False

    def handle_data(self, data):
        if self.body:
            self.parts.append(data)

    def text(self):
        raw = "".join(self.parts)
        return re.sub(r"\n(?:[ \t]*\n){2,}", "\n\n", raw).strip()


def generate():
    sections = []
    def add(title, body):
        sections.append(f"{title}\n{'=' * len(title)}\n\n{body.strip()}\n")

    add("Claude Session Share for Windows x64", (ROOT / "LICENSE").read_text(encoding="utf-8"))
    packages = normal_packages()
    add("Cargo dependencies for " + TARGET,
        "\n".join(f'{p["name"]} {p["version"]} — {p["license"] or "see license file"}' for p in packages))
    for p in packages:
        directory = Path(p["manifest_path"]).parent
        files = {f for f in directory.iterdir() if f.is_file() and re.match(
            r"^(?:unlicense|licen[sc]e|copying|copyright|notice)(?:[-._ ]|$)", f.name, re.I)}
        if p["license_file"]:
            files.add(directory / p["license_file"])
        if not files:
            raise ValueError(f'No license files for {p["name"]} {p["version"]}')
        for f in sorted(files, key=lambda path: path.name):
            add(f'{p["name"]} {p["version"]} / {f.name}', f.read_text(encoding="utf-8-sig"))

    doc = Path(run("rustc", "--print", "sysroot")) / "share" / "doc" / "rust"
    html = (doc / "COPYRIGHT-library.html").read_text(encoding="utf-8")
    notice = NoticeText()
    notice.feed(html)
    notice.close()
    add("Rust Standard Library / " + run("rustc", "--version"), notice.text())
    # Third-party notices are embedded in the HTML. In-tree entries use SPDX identifiers.
    in_tree, marker, _ = html.partition('<h2 id="out-of-tree-dependencies">')
    expressions = re.findall(r"<b>License:</b> ([^<]+)", in_tree)
    if not marker or not expressions:
        raise ValueError("Could not identify the standard library license index")
    terms = set(re.findall(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", " ".join(expressions)))
    for name in sorted(terms - {"AND", "OR", "WITH"}):
        file = doc / "licenses" / (name + ".txt")
        add("Rust license text / " + file.name, file.read_text(encoding="utf-8"))
    return "\n".join(line.rstrip() for line in "\n".join(sections).splitlines()) + "\n"


if __name__ == "__main__":
    output = ROOT / "dist" / "windows-x64" / "NOTICES.txt"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(generate().encode("utf-8"))
