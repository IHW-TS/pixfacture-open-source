import { SUBPROCESSORS, formatSubprocessorDate } from "@/lib/subprocessors";

export default function SubprocessorsTable() {
  const rows = SUBPROCESSORS;

  if (!rows.length) {
    return <p className="muted">Liste communiquée sur demande.</p>;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Nom</th>
          <th>Finalité</th>
          <th>Localisation</th>
          <th>Détails</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((sp) => (
          <tr key={`${sp.name}-${sp.purpose}`}>
            <td>{sp.name}</td>
            <td>{sp.purpose}</td>
            <td>{sp.location || "Non communiquée"}</td>
            <td>
              {sp.notes ? <div>{sp.notes}</div> : null}
              {sp.safeguards ? <div>Garanties : {sp.safeguards}</div> : null}
              {sp.lastUpdated ? (
                <div>Mise à jour : {formatSubprocessorDate(sp.lastUpdated) || sp.lastUpdated}</div>
              ) : null}
              {sp.dp_link ? (
                <div>
                  <a href={sp.dp_link} target="_blank" rel="noreferrer">
                    DPA / privacy
                  </a>
                </div>
              ) : null}
              {sp.website ? (
                <div>
                  <a href={sp.website} target="_blank" rel="noreferrer">
                    Site
                  </a>
                </div>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
