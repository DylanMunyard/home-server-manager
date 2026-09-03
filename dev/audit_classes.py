#!/usr/bin/env python3
import os
import re
import sys

def find_classes_in_tsx(src_dir):
    classes = set()
    for root, _, files in os.walk(src_dir):
        for f in files:
            if f.endswith('.tsx') or f.endswith('.ts'):
                path = os.path.join(root, f)
                with open(path, 'r', encoding='utf-8') as file:
                    content = file.read()
                    # Match className="...", className={'...'}, className={`...`}
                    matches = re.findall(r'className=(?:["\']([^"\']+)["\']|\{`([^`]+)`\}|\{["\']([^"\']+)["\']\})', content)
                    for m in matches:
                        raw = ' '.join([x for x in m if x])
                        # Remove ${...} dynamic expressions
                        cleaned = re.sub(r'\$\{[^}]+\}', ' ', raw)
                        for token in cleaned.split():
                            # Remove non-class syntax
                            token = token.strip('?:=,()"\';`{}')
                            # Ignore variable names or booleans or empty
                            if (token and 
                                not token.startswith('$') and 
                                not token.startswith('true') and 
                                not token.startswith('false') and
                                not re.match(r'^[0-9]+$', token)):
                                classes.add(token)
    return classes

def find_classes_in_css(css_file):
    with open(css_file, 'r', encoding='utf-8') as f:
        css = f.read()
    # Find all class selectors
    found = set(re.findall(r'\.([a-zA-Z0-9_-]+)', css))
    return found, css

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src_dir = os.path.join(root, 'ui', 'src')
    css_file = os.path.join(src_dir, 'theme.css')

    tsx_classes = find_classes_in_tsx(src_dir)
    css_classes, css_content = find_classes_in_css(css_file)

    missing = []
    for c in sorted(tsx_classes):
        # check if class exists as a selector or inside a string in css
        pattern = r'\.' + re.escape(c) + r'(?=[\s,.:;{>+~\[\)])'
        if not re.search(pattern, css_content):
            missing.append(c)

    print(f"Total classes referenced in TSX: {len(tsx_classes)}")
    print(f"Total classes found in theme.css: {len(css_classes)}")
    if missing:
        print(f"\nWARNING: {len(missing)} classes referenced in TSX are missing in theme.css:")
        for m in missing:
            print(f"  - {m}")
        sys.exit(1)
    else:
        print("\nSUCCESS: All TSX classes are defined in theme.css!")
        sys.exit(0)

if __name__ == '__main__':
    main()
