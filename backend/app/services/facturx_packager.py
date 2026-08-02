import io
import pikepdf


def pack_pdf_with_xml(
    pdf_bytes: bytes,
    xml_bytes: bytes,
    xml_filename: str = "factur-x.xml",
) -> bytes:
    """
    Emballe un PDF existant avec le XML Factur-X en pièce jointe intégrée
    et renvoie les octets du nouveau PDF.
    """
    with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
        # 1) Stream de fichier embarqué (MIME type application/xml)
        ef_stream = pdf.make_stream(
            xml_bytes,
            {
                "/Type": "/EmbeddedFile",
                "/Subtype": "/application#2Fxml",  # application/xml encodé
            },
        )

        # 2) Filespec pour l’attachement Factur-X
        #    - nom : factur-x.xml
        #    - AFRelationship = /Data  (clé pour la validation Factur-X)
        filespec = pdf.make_indirect(
            pikepdf.Dictionary(
                {
                    "/Type": "/Filespec",
                    "/F": xml_filename,
                    "/UF": xml_filename,  # nom Unicode
                    "/AFRelationship": "/Data",
                    "/EF": pikepdf.Dictionary({"/F": ef_stream}),
                }
            )
        )

        # 3) Enregistrer dans le catalogue Names/EmbeddedFiles
        root = pdf.Root  # IMPORTANT : Root
        if "/Names" not in root:
            root["/Names"] = pikepdf.Dictionary()
        names = root["/Names"]

        embedded_files = names.get("/EmbeddedFiles")
        if embedded_files is None:
            embedded_files = pdf.make_indirect(
                pikepdf.Dictionary({"/Names": []})
            )
            names["/EmbeddedFiles"] = embedded_files

        ef_names = embedded_files["/Names"]
        ef_names.append(xml_filename)
        ef_names.append(filespec)

        # 4) Associer le XML comme fichier associé (/AF)
        root["/AF"] = [filespec]

        # 5) Sauvegarder en mémoire
        out = io.BytesIO()
        pdf.save(out)
        return out.getvalue()
