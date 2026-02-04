# False Negatives Investigation & Fixes

## Issues Identified

### 1. db_schema - 0 tables detected (Drizzle)
**Problem**: Drizzle schema parser not detecting tables
**Root Cause**: 
- Regex pattern might be too strict for all Drizzle variations
- File search patterns might not cover all schema locations
- Missing support for Drizzle's newer patterns

**Fix Strategy**:
- Expand file search patterns to include `**/schema/**/*.ts`, `**/db/**/*.ts`, `**/models/**/*.ts`
- Improve regex to handle more Drizzle patterns
- Add fallback detection for common Drizzle file naming patterns

### 2. api_contracts - 0 endpoints detected (Express)
**Problem**: Express route detection failing
**Root Cause**:
- Route files might not match the filter patterns
- Routes might be defined in non-standard ways
- Import/export patterns might not be detected

**Fix Strategy**:
- Expand file filtering to be less restrictive
- Add more route detection patterns
- Improve detection of route aggregator files

### 3. find_large_files - False negative at 500 threshold
**Problem**: Tool works but threshold too high for user's codebase
**Root Cause**: Default threshold of 500 lines, but user has files >1000 lines
**Fix Strategy**: 
- Lower default threshold to 300 lines (more reasonable)
- Document that threshold can be adjusted

### 4. find_long_functions - Possible false negative
**Problem**: AST parsing might fail silently, regex fallback might miss functions
**Root Cause**:
- AST parsing errors are caught silently
- Regex patterns might not match all function styles
**Fix Strategy**:
- Improve error logging for AST failures
- Enhance regex patterns for function detection
- Add more function signature patterns

## Implementation Plan

1. ✅ Improve db_schema Drizzle detection
   - Added lenient pattern matching for edge cases
   - Enhanced table name and body extraction
   - Better handling of various Drizzle syntax variations

2. ✅ Enhance api_contracts Express route detection  
   - Expanded file filtering to include index files
   - Less restrictive file pattern matching
   - Better detection of routes in non-standard locations

3. ✅ Adjust find_large_files default threshold
   - Changed default from 500 to 300 lines (more reasonable)
   - Users can still override with threshold parameter

4. ⚠️ find_long_functions detection
   - Already has AST parsing + regex fallback
   - May need further investigation if issues persist

## Changes Made

### src/analyzers/db-schema.ts
- Added lenient table matching pattern for edge cases
- Improved table name extraction from various Drizzle patterns
- Better handling of callback-style table definitions

### src/analyzers/api-contract.ts  
- Expanded route file filtering to include index files
- Less restrictive file pattern matching
- Better detection of routes in various file structures

### src/tools/quality.ts
- Changed `find_large_files` default threshold from 500 to 300 lines
- Updated description to reflect new default

## Testing Recommendations

1. Test db_schema with actual Drizzle schema files
2. Test api_contracts with Express routes in various file structures
3. Verify find_large_files now catches files at 300+ lines
4. Monitor find_long_functions for any remaining false negatives
