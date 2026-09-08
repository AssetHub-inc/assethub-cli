/** Standard-library-only helper embedded in the published CLI by TypeScript compilation. */
export const EXTRACT_WORKBOOK_PYTHON = String.raw`
import json, posixpath, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree as E

source, output = Path(sys.argv[1]), Path(sys.argv[2])
ns = {
 's': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
 'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
 'rd': 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata',
 'xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
 'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
}
output.mkdir(parents=True, exist_ok=True)
result = {'sheets': [], 'images': [], 'warnings': []}
with zipfile.ZipFile(source) as z:
 names = set(z.namelist())
 def xml(path):
  return E.fromstring(z.read(path))
 def resolve(part, target):
  return target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
 def rels(part):
  name = posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part) + '.rels')
  if name not in names:
   return {}
  return {e.get('Id'): resolve(part, e.get('Target', '')) for e in xml(name) if e.get('TargetMode') != 'External'}
 def col_name(number):
  result = ''
  while number:
   number, remainder = divmod(number - 1, 26)
   result = chr(65 + remainder) + result
  return result
 strings = []
 if 'xl/sharedStrings.xml' in names:
  strings = [''.join(n.text or '' for n in e.iter('{'+ns['s']+'}t')) for e in xml('xl/sharedStrings.xml')]
 placements = {}
 def place(target, value):
  if target in names:
   placements.setdefault(target, []).append(value)
  else:
   result['warnings'].append('Image relationship target is missing: ' + str(target))
 # Excel rich-value images use cell vm -> value metadata -> future metadata -> rich value -> relationship.
 rich_paths = ['xl/richData/richValueRel.xml', 'xl/richData/rdrichvalue.xml', 'xl/metadata.xml']
 rich_targets = {}
 if all(p in names for p in rich_paths):
  try:
   rich_part = rich_paths[0]
   relationships = rels(rich_part)
   relation_ids = [e.get('{'+ns['r']+'}id') for e in xml(rich_part)]
   values = [[e.text for e in row] for row in xml(rich_paths[1])]
   metadata = xml(rich_paths[2])
   futures = next(e for e in metadata.findall('s:futureMetadata', ns) if e.get('name') == 'XLRICHVALUE')
   future_indexes = [int(next(e.iter('{'+ns['rd']+'}rvb')).get('i')) for e in futures]
   metadata_types = metadata.find('s:metadataTypes', ns)
   rich_type = next(i+1 for i,e in enumerate(metadata_types) if e.get('name') == 'XLRICHVALUE')
   local_image_fields = []
   structure_path = 'xl/richData/rdrichvaluestructure.xml'
   if structure_path in names:
    for structure in xml(structure_path):
     local_image_fields.append(next((i for i,k in enumerate(structure) if k.get('n') == '_rvRel:LocalImageIdentifier'), 0))
   rich_rows = list(xml(rich_paths[1]))
   for index, block in enumerate(metadata.find('s:valueMetadata', ns)):
    rc = next((e for e in block if int(e.get('t', '0')) == rich_type), None)
    if rc is None:
     continue
    value_index = future_indexes[int(rc.get('v'))]
    structure_index = int(rich_rows[value_index].get('s', '0'))
    field = local_image_fields[structure_index] if structure_index < len(local_image_fields) else 0
    relation_index = int(values[value_index][field])
    rich_targets[index+1] = relationships[relation_ids[relation_index]]
  except (KeyError, IndexError, ValueError, TypeError, StopIteration) as error:
   result['warnings'].append('Rich-value cell mapping incomplete: ' + type(error).__name__ + ': ' + str(error))
 book_rels = rels('xl/workbook.xml')
 for sheet in xml('xl/workbook.xml').find('s:sheets', ns):
  name = sheet.get('name', '')
  part = book_rels[sheet.get('{'+ns['r']+'}id')]
  document = xml(part)
  cells = []
  for cell in document.findall('.//s:sheetData/s:row/s:c', ns):
   address = cell.get('r')
   kind = cell.get('t', 'n')
   value_node = cell.find('s:v', ns)
   cached = value_node.text if value_node is not None else None
   if kind == 's' and cached is not None:
    value = strings[int(cached)]
   elif kind == 'inlineStr':
    value = ''.join(n.text or '' for n in cell.findall('.//s:t', ns))
   else:
    value = cached
   formula = cell.find('s:f', ns)
   record = {'cell': address, 'type': kind, 'value': value}
   if formula is not None:
    record['formula'] = formula.text or ''
   if value is not None or formula is not None:
    cells.append(record)
   vm = cell.get('vm')
   if vm:
    target = rich_targets.get(int(vm))
    if target:
     place(target, {'sheet': name, 'cell': address, 'mapping': 'rich_value_cell'})
    else:
     result['warnings'].append('Unresolved image metadata at ' + name + '!' + str(address))
  result['sheets'].append({'name': name, 'part': part, 'cells': cells})
  sheet_rels = rels(part)
  for drawing in document.findall('s:drawing', ns):
   drawing_part = sheet_rels.get(drawing.get('{'+ns['r']+'}id'))
   if not drawing_part or drawing_part not in names:
    result['warnings'].append('Drawing relationship missing in ' + name)
    continue
   drawing_rels = rels(drawing_part)
   for anchor in xml(drawing_part):
    start = anchor.find('xdr:from', ns)
    placement = {'sheet': name, 'mapping': 'drawing_anchor'}
    if start is not None:
     row = int(start.find('xdr:row', ns).text)+1
     column = int(start.find('xdr:col', ns).text)+1
     placement['cell'] = col_name(column) + str(row)
    for blip in anchor.iter():
     target = drawing_rels.get(blip.get('{'+ns['r']+'}embed'))
     if target and target.startswith('xl/media/'):
      image_placement = placement.copy()
      if blip.tag.endswith('}imgLayer'):
       image_placement['mapping'] = 'drawing_image_layer'
      place(target, image_placement)
 # Preserve every original media byte, including images whose placement cannot be resolved.
 for index, media in enumerate(sorted(n for n in names if n.startswith('xl/media/') and not n.endswith('/'))):
  filename = 'image-' + str(index+1).zfill(4) + Path(media).suffix.lower()
  (output / filename).write_bytes(z.read(media))
  result['images'].append({'file': filename, 'workbookMediaPath': media, 'placements': placements.get(media, [])})
  if media not in placements:
   result['warnings'].append('Image extracted without cell mapping: ' + media)
(output / 'workbook.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
lines = []
for sheet in result['sheets']:
 lines.append('## Sheet: ' + sheet['name'])
 for cell in sheet['cells']:
  value = '' if cell['value'] is None else str(cell['value'])
  formula = (' [formula: ' + cell['formula'] + ']') if 'formula' in cell else ''
  lines.append(cell['cell'] + ': ' + value + formula)
 lines.append('')
(output / 'text.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
`
