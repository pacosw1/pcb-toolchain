"""Extract source PDF text/page metadata and render requested pages for review.

Read-only with respect to PDFs. Generated text/images are inspection artifacts.
Run with: uv run --with pymupdf python tools/inspect-pdfs.py [PDF ...]
"""
from pathlib import Path
import json
import sys
import pymupdf

for name in sys.argv[1:]:
    source = Path(name)
    document = pymupdf.open(source)
    text_pages = [f"\n--- PDF PAGE {index + 1} ---\n" + page.get_text() for index, page in enumerate(document)]
    source.with_suffix('.txt').write_text(''.join(text_pages), encoding='utf-8')
    inspection = {'file':str(source),'pages':len(document),'metadata':document.metadata,'text_extracted':True}
    source.with_suffix('.inspection.json').write_text(json.dumps(inspection,indent=2)+'\n',encoding='utf-8')
    rendered = source.parent / 'renders'
    rendered.mkdir(exist_ok=True)
    for number in sorted({0, len(document)-1}):
        document[number].get_pixmap(matrix=pymupdf.Matrix(1.4,1.4)).save(rendered/f'{source.stem}-p{number+1}.png')
    print(json.dumps({'file':source.name,'pages':len(document),'metadata_title':document.metadata.get('title')}))
