import json
import sys
from pathlib import Path

import pdfplumber


EXPECTED = {
    "01-cotizacion.pdf": ["COT-260829-0001", "BR-100245", "$2,900.00"],
    "02-oc-cliente.pdf": ["OC-260829-0001", "COT-260829-0001", "$2,900.00"],
    "03-oc-proveedor.pdf": ["OCP-260829-0001", "OC-260829-0001", "Bio-Rad"],
    "04-entrada-almacen.pdf": ["INV-IN-260829-0001", "OCP-260829-0001", "BR-100245", " 2 - -"],
    "05-salida-almacen.pdf": ["INV-OUT-260829-0001", "OC-260829-0001", "BR-100245", " 2 - -"],
    "06-remision.pdf": ["REM-260829-0001", "INV-OUT-260829-0001", "BR-100245", " 2 - -"],
    "07-expediente.pdf": ["EXP-OC-260829-0001", "REM-260829-0001", "Auditoria:"],
}


def main() -> int:
    pdf_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("output/pdf/flujo-validacion")
    results = []
    failed = False

    for filename, required in EXPECTED.items():
        path = pdf_dir / filename
        with pdfplumber.open(path) as document:
            text = "\n".join(page.extract_text() or "" for page in document.pages)
            page_count = len(document.pages)

        missing = [value for value in required if value not in text]
        corrupt = [value for value in ("Ã", "Â", "�") if value in text]
        valid = page_count == 1 and not missing and not corrupt
        failed = failed or not valid
        results.append(
            {
                "file": filename,
                "pages": page_count,
                "characters": len(text),
                "missing": missing,
                "corrupt_markers": corrupt,
                "valid": valid,
            }
        )

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
