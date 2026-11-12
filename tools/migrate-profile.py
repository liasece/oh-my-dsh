#!/usr/bin/env python3
"""把三个旧插件的 profile 配置迁移成 oh-my-dsh 的一段。

用法：
    python3 tools/migrate-profile.py <profile 目录> [--dry-run]

只改两处：
  1. cordis.patch.yml：删掉 `- id: peak-valley-model` 那一行，换成 `- id: oh-my-dsh`，
     把原来的开关状态（sessions / lastToggle）原样搬到 `peakValley` 下面。
  2. package.json：dependencies 里的三个 link: 换成 oh-my-dsh，
     dsh.profile.bundles 里的三个包名合并成一个。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

NEW_ID = 'oh-my-dsh'
NEW_NAME = 'oh-my-dsh'
OLD_IDS = ('peak-valley-model', 'dsh-peak-valley-model')
OLD_PACKAGES = ('dsh-peak-valley-model', 'dsh-prompt-candidates', 'dsh-prompt-history')
SOURCE = 'link:' + str(Path(__file__).resolve().parent.parent)


def find_peak_block(lines: list[str]) -> tuple[int, int]:
    """返回旧峰谷行的 [start, end) 行号（end 指向下一个顶层 `- ` 行）。"""
    start = None
    for index, line in enumerate(lines):
        if line.rstrip() == f'- id: {OLD_IDS[0]}':
            start = index
            break
    if start is None:
        raise SystemExit('没找到 `- id: peak-valley-model` 行，先确认这个 profile 里还装着旧插件')
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith('- '):
            end = index
            break
    return start, end


def peak_config_body(lines: list[str], start: int, end: int) -> list[str]:
    """取出旧行 `config:` 下面的内容（保持原缩进，去掉空行）。"""
    body_start = None
    for index in range(start, end):
        if lines[index].rstrip() == '  config:':
            body_start = index + 1
            break
    if body_start is None:
        return []
    body = [line for line in lines[body_start:end] if line.strip()]
    # 去掉文件里最后那一行的分隔空行已经在上面过滤掉。
    return body


def strip_legacy(body: list[str]) -> list[str]:
    """删掉旧 schema 里已经不存在（或含义变了）的字段：enabled、timeline。"""
    kept: list[str] = []
    skipping = False
    for line in body:
        indent = len(line) - len(line.lstrip())
        if indent == 4 and re.match(r'^    (enabled|timeline):', line):
            skipping = True
            continue
        if skipping:
            # 跳过这个字段的子行，直到回到同级或更外层。
            if indent > 4:
                continue
            skipping = False
        kept.append(line)
    return kept


def indent(lines: list[str], extra: int) -> list[str]:
    return [(' ' * extra + line) if line.strip() else line for line in lines]


def build_row(body: list[str]) -> list[str]:
    row = [
        f'- id: {NEW_ID}',
        f'  name: {NEW_NAME}',
        '  config:',
        '    peakValley:',
        '      enabled: true',
    ]
    row += indent(body, 2)
    row += [
        '    candidates:',
        '      enabled: true',
        '      maxSuggestions: 2',
        '      historyMessages: 12',
        '    history:',
        '      enabled: true',
        '      limit: 100',
        '',
    ]
    return row


def migrate_patch(path: Path) -> None:
    text = path.read_text()
    lines = text.splitlines()
    start, end = find_peak_block(lines)
    body = strip_legacy(peak_config_body(lines, start, end))
    if not any(re.match(r'^\s+sessions:', line) for line in body):
        raise SystemExit('旧行里没有 sessions：拒绝在没有确认开关状态的情况下迁移')

    row = build_row(body)
    merged = lines[:start] + row + lines[end:]
    # 收一下因为删行留下的连续空行。
    cleaned: list[str] = []
    for line in merged:
        if line.strip() == '' and cleaned and cleaned[-1].strip() == '':
            continue
        cleaned.append(line)
    path.write_text('\n'.join(cleaned) + '\n')


def migrate_package(path: Path) -> None:
    data = json.loads(path.read_text())
    dependencies = data.get('dependencies') or {}
    for package in OLD_PACKAGES:
        dependencies.pop(package, None)
    dependencies[NEW_ID] = SOURCE
    data['dependencies'] = dict(sorted(dependencies.items()))
    bundles = ((data.get('dsh') or {}).get('profile') or {}).get('bundles')
    if bundles is None:
        raise SystemExit('package.json 里没有 dsh.profile.bundles')
    replaced = [NEW_ID if item in OLD_PACKAGES else item for item in bundles]
    # 去重，但保留第一次出现的位置。
    seen: set[str] = set()
    data['dsh']['profile']['bundles'] = [
        item for item in replaced if not (item in seen or seen.add(item))
    ]
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    profile = Path(sys.argv[1]).expanduser()
    for name in ('cordis.patch.yml', 'package.json'):
        if not (profile / name).exists():
            raise SystemExit(f'{profile / name} 不存在')
    migrate_patch(profile / 'cordis.patch.yml')
    migrate_package(profile / 'package.json')
    print(f'迁移完成：{profile}')


if __name__ == '__main__':
    main()
