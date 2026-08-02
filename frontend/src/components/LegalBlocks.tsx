import { getLegalConfig } from "@/lib/legalConfig";

type Subprocessor = {
  name: string;
  service: string;
  location?: string;
  website?: string;
};

const DEFAULT_SUBPROCESSORS: Subprocessor[] = [];

export function Subprocessors({
  items = DEFAULT_SUBPROCESSORS,
  title = "Sous-traitants",
  updatedAt,
}: {
  items?: Subprocessor[];
  title?: string;
  updatedAt?: string;
}) {
  const updatedLabel = updatedAt || "Date de mise à jour : non communiquée";
  return (
    <div className="card grid-simple gap-12">
      <div>
        <h3 className="m-0">{title}</h3>
        <p className="muted mt-6 mb-0">{updatedLabel}</p>
      </div>
      {items.length ? (
        <ul className="m-0">
          {items.map((item, idx) => {
            const parts = [item.service, item.location].filter(Boolean).join(" - ");
            return (
              <li key={idx}>
                <b>{item.name}</b>
                <div className="muted">{parts || "Service communiqué sur demande"}</div>
                {item.website ? (
                  <div className="muted">
                    <a href={item.website} target="_blank" rel="noreferrer">
                      {item.website}
                    </a>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted m-0">Liste communiquée sur demande ou via le DPA.</p>
      )}
    </div>
  );
}

export function ContactDpo({ email, address, title }: { email?: string; address?: string; title?: string }) {
  const legal = getLegalConfig();
  const resolvedTitle = title || (legal.dpoEmail ? "DPO" : "Contact RGPD");
  const dpoEmail = email || legal.dpoEmail || legal.privacyContactEmail || legal.email;
  const dpoAddress = address || "";
  return (
    <div className="card grid-simple gap-10">
      <h3 className="m-0">{resolvedTitle}</h3>
      <div className="muted">
        Email : <b>{dpoEmail}</b>
      </div>
      {dpoAddress ? <div className="muted">Adresse : {dpoAddress}</div> : null}
      <div className="muted">Objet : demandes RGPD, exercice des droits, incidents.</div>
    </div>
  );
}
