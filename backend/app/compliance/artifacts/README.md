# Normative validation artifacts

This folder documents the expected artifact layout for the normative validator (XSD + Schematron).
The repository does not ship any official schemas; mount them at runtime and point
`COMPLIANCE_ARTIFACTS_DIR` to the root directory.

Expected layout:

- cii/cii.xsd
- cii/cii.sch
- ubl/ubl.xsd
- ubl/ubl.sch

The API will return HTTP 501 with "validation normative non configuree" when
`COMPLIANCE_ARTIFACTS_DIR` is not set. Missing files when the variable is set
are treated as a server configuration error.
