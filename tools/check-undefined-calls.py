#!/usr/bin/env python3
"""Flag calls to identifiers that nothing in the same file declares or imports.

Why this exists: `gjs -m <file>` only checks SYNTAX. A call to a helper that was
deleted — say by an edit that replaced a block of code and swallowed a function
still referenced elsewhere in the file — parses perfectly and then throws
ReferenceError at runtime. In a GNOME Shell extension that surfaces as the
extension going to ERROR state, and since the Shell caches extension modules,
recovering needs a full session restart. This script catches that class of
mistake before the code is loaded.

It is a heuristic, not a JS parser. It strips comments and string literals, then
collects declarations (function/class/const/let/var, class and object methods,
their parameters, destructured bindings, arrow parameters and import bindings)
and reports any call to a bare identifier that is in none of them. A name
reached only through `this.`, a member expression or a computed property is not
considered a call here, so those are never reported.

Usage:
    tools/check-undefined-calls.py [path ...]     # default: the whole checkout

Exits 1 when something is reported, 0 when clean.
"""

import pathlib
import re
import sys

SKIP_DIRS = {'dist', 'node_modules', '.git'}

# Keywords and runtime globals that are legitimately "called" or read without a
# declaration anywhere in the file.
BUILTIN = set("""
if for while switch catch return typeof new delete void throw do else try finally
class extends of in instanceof await yield async super this
print printerr log logError
Math JSON Object Array String Number Boolean Error Promise Symbol Map Set
WeakMap WeakSet Date RegExp Proxy Reflect BigInt
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent
setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone
globalThis global TextEncoder TextDecoder Function Infinity NaN undefined
""".split())

METHOD_DEF = r'(?m)^\s*(?:static\s+|async\s+|get\s+|set\s+|\*)*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{'


# Comments and string literals in ONE alternation, so the leftmost token wins.
# Stripping them in separate passes was wrong in both orders: `//` inside a
# string (a URL in a template literal) was taken for a comment, which deleted
# the closing backtick and let the template pattern swallow every declaration
# up to the next backtick — reporting calls to perfectly real functions.
NOISE = re.compile(
    r'/\*.*?\*/'
    r'|//[^\n]*'
    r'|`(?:[^`\\]|\\.)*`'
    r"|'(?:[^'\\\n]|\\.)*'"
    r'|"(?:[^"\\\n]|\\.)*"',
    re.S)


def strip_noise(src: str) -> str:
    """Remove comments and string bodies so their contents never look like code."""
    def blank(m):
        token = m.group(0)
        if token.startswith('/'):
            # Keep the newlines so reported line numbers stay right.
            return ' ' + '\n' * token.count('\n')
        return token[0] * 2 + '\n' * token.count('\n')
    return NOISE.sub(blank, src)


def declarations(src: str) -> set:
    names = set(BUILTIN)
    names |= set(re.findall(r'\bfunction\s+([A-Za-z_$][\w$]*)', src))
    names |= set(re.findall(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)', src))
    names |= set(re.findall(r'\bclass\s+([A-Za-z_$][\w$]*)', src))

    for name, params in re.findall(METHOD_DEF, src):
        names.add(name)
        names |= set(re.findall(r'[A-Za-z_$][\w$]*', params))

    for chunk in re.findall(r'\b(?:const|let|var)\s*[\{\[]([^\}\]]*)[\}\]]', src):
        names |= set(re.findall(r'[A-Za-z_$][\w$]*', chunk))
    for chunk in re.findall(r'\(([^()]*)\)\s*=>', src):
        names |= set(re.findall(r'[A-Za-z_$][\w$]*', chunk))
    for chunk in re.findall(r'function\s*[\w$]*\s*\(([^()]*)\)', src):
        names |= set(re.findall(r'[A-Za-z_$][\w$]*', chunk))

    for m in re.finditer(
            r'import\s+(?:([\w$]+)\s*,\s*)?(?:\*\s+as\s+([\w$]+)|\{([^}]*)\}|([\w$]+))', src):
        for group in (m.group(1), m.group(2), m.group(4)):
            if group:
                names.add(group)
        if m.group(3):
            for part in m.group(3).split(','):
                part = part.strip().split(' as ')[-1].strip()
                if part:
                    names.add(part)
    return names


def check(path: pathlib.Path) -> list:
    src = strip_noise(path.read_text())
    known = declarations(src)
    findings, seen = [], set()
    for m in re.finditer(r'(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(', src):
        name = m.group(1)
        if name in known or name in seen:
            continue
        seen.add(name)
        findings.append((src[:m.start()].count('\n') + 1, name))
    return findings


def main(argv):
    roots = [pathlib.Path(a) for a in argv[1:]] or [pathlib.Path('.')]
    files = []
    for root in roots:
        if root.is_file():
            files.append(root)
            continue
        files += [p for p in root.rglob('*.js')
                  if not SKIP_DIRS & set(p.parts)]

    total = 0
    for path in sorted(set(files)):
        for line, name in check(path):
            print(f'{path}:{line}: call to undeclared `{name}`')
            total += 1

    if total:
        print(f'\n{total} undeclared call(s) in {len(files)} file(s)')
        return 1
    print(f'clean: no undeclared calls in {len(files)} file(s)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
