# FLOOR360 shop-drawing brand assets

Converted once and committed. The runner embeds these files; it does not convert fonts or the logo at runtime.

| File | Source | Conversion |
|---|---|---|
| `BrandonText-Regular.ttf` | `BrandonText-Regular.woff2` | fontTools: woff flavor cleared, then CFF outlines converted to quadratic TrueType |
| `BrandonText-Bold.ttf` | `BrandonText-Bold.woff2` | same |
| `BrandonText-Light.ttf` | `BrandonText-Light.woff2` | same |
| `floor360-logo.pdf` | `FLOOR360_MADMKE_Horizontal_2023.eps` | Ghostscript `pdfwrite -dEPSCrop`, then a pdf-lib page copy that drops the source document info |
| `floor360-logo.svg` | that PDF | `pdf2svg` |

Brandon Text is licensed to FLOOR360 company-wide, including embedding in PDFs. It is not covered by the AGPL grant on the rest of this repository. Do not extract it for any other use.

```bash
python3 - << 'PY'
from fontTools.ttLib import TTFont, newTable
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

def woff2_to_ttf(src, dest):
    font = TTFont(src)
    font.flavor = None
    glyph_set = font.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = font.getGlyphOrder()
    glyf.glyphs = {}
    for name in glyf.glyphOrder:
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(Cu2QuPen(pen, 1.0, reverse_direction=False))
        glyf.glyphs[name] = pen.glyph()
    font["glyf"] = glyf
    font["loca"] = newTable("loca")
    del font["CFF "]
    font.sfntVersion = "\x00\x01\x00\x00"
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    for field, value in {
        "maxZones": 1, "maxTwilightPoints": 0, "maxStorage": 0,
        "maxFunctionDefs": 0, "maxInstructionDefs": 0, "maxStackElements": 0,
        "maxSizeOfInstructions": 0, "maxComponentElements": 0, "maxComponentDepth": 0,
    }.items():
        setattr(maxp, field, value)
    font.save(dest)

for name in ["BrandonText-Regular", "BrandonText-Bold", "BrandonText-Light"]:
    woff2_to_ttf(f"{name}.woff2", f"{name}.ttf")
PY
gs -dNOPAUSE -dBATCH -dEPSCrop -sDEVICE=pdfwrite -sOutputFile=floor360-logo.pdf FLOOR360_MADMKE_Horizontal_2023.eps
pdf2svg floor360-logo.pdf floor360-logo.svg
```
