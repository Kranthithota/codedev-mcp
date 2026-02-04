#!/usr/bin/env python3
"""
Migrate server.tool() calls to server.registerTool() with output schemas.
Handles brace-counting for nested objects in input schemas and callbacks.
"""

import re, sys

def find_matching_brace(lines, start_idx, start_col=0):
    """Find the line index where a brace-delimited block closes."""
    depth = 0
    started = False
    for i in range(start_idx, len(lines)):
        line = lines[i] if i > start_idx else lines[i][start_col:]
        for ch in line:
            if ch == '{':
                depth += 1
                started = True
            elif ch == '}':
                depth -= 1
                if started and depth == 0:
                    return i
    return -1

def extract_string_arg(lines, start_idx):
    """Extract a string argument (possibly multi-line) starting at start_idx.
    Returns (string_content, end_idx)."""
    collected = []
    for i in range(start_idx, len(lines)):
        line = lines[i]
        collected.append(line)
        # Check if this line ends the string (closing quote + comma)
        stripped = ''.join(collected)
        # Match 'string content',
        if re.search(r"'[^']*',\s*$", stripped.strip()) or re.search(r"'[^']*',\s*$", line.strip()):
            return '\n'.join(collected).strip().rstrip(','), i
    return '\n'.join(collected).strip().rstrip(','), start_idx

def extract_object_arg(lines, start_idx):
    """Extract a brace-delimited object argument starting at start_idx.
    Returns (object_text_lines, end_idx)."""
    end = find_matching_brace(lines, start_idx)
    if end < 0:
        return [lines[start_idx]], start_idx
    obj_lines = lines[start_idx:end+1]
    # Strip trailing comma from last line
    obj_lines[-1] = obj_lines[-1].rstrip().rstrip(',')
    return obj_lines, end

def migrate(input_path, output_path):
    with open(input_path, 'r') as f:
        lines = f.readlines()
    
    # Strip newlines for easier processing, rejoin later
    lines = [l.rstrip('\n') for l in lines]
    
    output = []
    i = 0
    migrated = 0
    
    while i < len(lines):
        line = lines[i]
        
        # Match: server.tool(
        if line.strip() == 'server.tool(':
            # Parse the 5 arguments: name, description, inputSchema, annotations, callback
            
            # 1. Tool name (next line): 'tool_name',
            i += 1
            name_line = lines[i].strip()
            name_match = re.match(r"'([^']+)',", name_line)
            if not name_match:
                # Not a standard tool registration, keep as-is
                output.append('server.tool(')
                output.append(lines[i])
                i += 1
                continue
            tool_name = name_match.group(1)
            
            # 2. Description (next line(s)): 'some long text',
            i += 1
            desc_text, i = extract_string_arg(lines, i)
            
            # 3. Input schema: { ... },
            i += 1
            input_schema_lines, i = extract_object_arg(lines, i)
            input_schema_text = '\n'.join(input_schema_lines)
            is_empty_schema = input_schema_text.strip() in ['{}', '{ }']
            
            # 4. Annotations: { readOnlyHint: ..., ... },
            i += 1
            ann_lines, i = extract_object_arg(lines, i)
            ann_text = '\n'.join(ann_lines)
            
            # 5. Callback: async (params) => { ... } or async () => { ... }
            # This starts on the next line - we just leave it as-is
            i += 1
            
            # Build the registerTool call
            output.append(f"server.registerTool('{tool_name}', {{")
            output.append(f"  description: {desc_text},")
            if not is_empty_schema:
                # Re-indent inputSchema
                output.append(f"  inputSchema: {input_schema_text},")
            output.append(f"  outputSchema: outputSchemas.{tool_name},")
            output.append(f"  annotations: {ann_text},")
            output.append('},')
            
            # The callback line (async ...) continues from here
            # Don't increment i - will be picked up in next iteration
            migrated += 1
            continue
        
        output.append(line)
        i += 1
    
    with open(output_path, 'w') as f:
        f.write('\n'.join(output) + '\n')
    
    print(f"Migrated {migrated} server.tool() → server.registerTool() calls")
    return migrated

if __name__ == '__main__':
    n = migrate('src/index.ts', 'src/index.ts.migrated')
    if n == 33:
        import shutil
        shutil.move('src/index.ts.migrated', 'src/index.ts')
        print("✅ Migration applied to src/index.ts")
    else:
        print(f"⚠️ Expected 33, got {n}. Check src/index.ts.migrated manually.")
