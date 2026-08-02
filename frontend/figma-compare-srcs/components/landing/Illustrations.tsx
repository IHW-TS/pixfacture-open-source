import { motion } from "motion/react";

/* ─────────────────────────────────────────────────────────
   InvoiceIllustration — ProductOverview bloc 1 (fond clair)
   ───────────────────────────────────────────────────────── */
export function InvoiceIllustration() {
  return (
    <svg viewBox="0 0 480 360" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      {/* Fond */}
      <rect width="480" height="360" rx="20" fill="#eef2ff" />

      {/* Grille de points */}
      {Array.from({ length: 10 }).map((_, row) =>
        Array.from({ length: 14 }).map((_, col) => (
          <circle key={`${row}-${col}`} cx={22 + col * 34} cy={22 + row * 36} r="1.2" fill="#c7d2fe" opacity="0.7" />
        ))
      )}

      {/* ── Facture principale ── */}
      <rect x="52" y="38" width="178" height="240" rx="14" fill="white" stroke="#e0e7ff" strokeWidth="1.5" />
      {/* En-tête bleue */}
      <rect x="52" y="38" width="178" height="52" rx="14" fill="#1d4ed8" />
      <rect x="52" y="68" width="178" height="22" fill="#1d4ed8" />
      {/* Icône doc */}
      <rect x="70" y="54" width="22" height="22" rx="5" fill="white" opacity="0.2" />
      <rect x="75" y="59" width="12" height="2.5" rx="1.2" fill="white" opacity="0.8" />
      <rect x="75" y="63.5" width="8" height="2.5" rx="1.2" fill="white" opacity="0.6" />
      {/* Texte d'en-tête */}
      <rect x="100" y="56" width="60" height="7" rx="3.5" fill="white" opacity="0.9" />
      <rect x="100" y="67" width="40" height="5" rx="2.5" fill="white" opacity="0.5" />
      {/* Lignes de contenu */}
      <rect x="72" y="108" width="70" height="6" rx="3" fill="#e0e7ff" />
      <rect x="72" y="120" width="100" height="5" rx="2.5" fill="#f1f5f9" />
      <rect x="72" y="132" width="50" height="5" rx="2.5" fill="#f1f5f9" />
      {/* Séparateur */}
      <line x1="72" y1="150" x2="208" y2="150" stroke="#e2e8f0" strokeWidth="1" />
      {/* Lignes articles */}
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x="72" y={162 + i * 18} width="40" height="5" rx="2.5" fill="#dbeafe" />
          <rect x="124" y={162 + i * 18} width="50" height="5" rx="2.5" fill="#f1f5f9" />
          <rect x="186" y={162 + i * 18} width="30" height="5" rx="2.5" fill={i % 2 === 0 ? "#d1fae5" : "#fef3c7"} />
        </g>
      ))}
      {/* Total */}
      <rect x="72" y="240" width="55" height="8" rx="4" fill="#1d4ed8" opacity="0.12" />
      <rect x="150" y="240" width="38" height="8" rx="4" fill="#1d4ed8" />

      {/* ── Badge XML/CII ── */}
      <rect x="246" y="52" width="118" height="56" rx="12" fill="white" stroke="#e0e7ff" strokeWidth="1.5" />
      <rect x="256" y="62" width="32" height="32" rx="8" fill="#eef2ff" />
      {/* Icône < > */}
      <text x="272" y="82" textAnchor="middle" fill="#4f46e5" fontSize="13" fontWeight="700" fontFamily="monospace">&lt;/&gt;</text>
      <rect x="296" y="65" width="56" height="6" rx="3" fill="#e0e7ff" />
      <rect x="296" y="75" width="40" height="5" rx="2.5" fill="#f1f5f9" />
      <rect x="296" y="85" width="30" height="4" rx="2" fill="#dbeafe" />

      {/* ── Badge PDF/A ── */}
      <rect x="246" y="122" width="118" height="56" rx="12" fill="white" stroke="#e0e7ff" strokeWidth="1.5" />
      <rect x="256" y="132" width="32" height="32" rx="8" fill="#fff7ed" />
      <text x="272" y="152" textAnchor="middle" fill="#ea580c" fontSize="11" fontWeight="800" fontFamily="system-ui">PDF</text>
      <rect x="296" y="135" width="56" height="6" rx="3" fill="#fed7aa" />
      <rect x="296" y="145" width="40" height="5" rx="2.5" fill="#f1f5f9" />
      <rect x="296" y="155" width="48" height="4" rx="2" fill="#fef3c7" />

      {/* ── Checkmark principal ── */}
      <circle cx="305" cy="248" r="42" fill="#059669" opacity="0.08" />
      <circle cx="305" cy="248" r="28" fill="#059669" opacity="0.14" />
      <circle cx="305" cy="248" r="20" fill="#059669" />
      <path d="M295 248 L302 255 L316 241" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <text x="305" y="292" textAnchor="middle" fill="#059669" fontSize="10" fontWeight="700" fontFamily="system-ui">XSD · CII</text>

      {/* ── Flèches de flux ── */}
      <path d="M234 78 L248 78" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3" />
      <polygon points="246,75 252,78 246,81" fill="#6366f1" />
      <path d="M234 148 L248 148" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3" />
      <polygon points="246,145 252,148 246,151" fill="#6366f1" />
      <path d="M314 180 L305 224" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeDasharray="3 3" />
      <polygon points="302,222 305,228 308,222" fill="#059669" />

      {/* ── Label Factur-X ── */}
      <rect x="364" y="64" width="88" height="30" rx="8" fill="#1d4ed8" opacity="0.1" stroke="#1d4ed8" strokeOpacity="0.25" strokeWidth="1" />
      <text x="408" y="83" textAnchor="middle" fill="#1d4ed8" fontSize="11" fontWeight="700" fontFamily="system-ui">Factur-X ✓</text>

      {/* ── Label PA/DGFiP ── */}
      <rect x="364" y="108" width="88" height="30" rx="8" fill="#7c3aed" opacity="0.08" stroke="#7c3aed" strokeOpacity="0.2" strokeWidth="1" />
      <text x="408" y="127" textAnchor="middle" fill="#7c3aed" fontSize="11" fontWeight="700" fontFamily="system-ui">Connecteurs PA</text>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────
   ArchiveIllustration — ProductOverview bloc 2 (fond clair)
   ───────────────────────────────────────────────────────── */
export function ArchiveIllustration() {
  return (
    <svg viewBox="0 0 480 360" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      {/* Fond */}
      <rect width="480" height="360" rx="20" fill="#f0fdf4" />

      {/* Grille de points */}
      {Array.from({ length: 9 }).map((_, row) =>
        Array.from({ length: 13 }).map((_, col) => (
          <circle key={`${row}-${col}`} cx={24 + col * 36} cy={24 + row * 38} r="1.2" fill="#bbf7d0" opacity="0.6" />
        ))
      )}

      {/* ── Timeline centrale ── */}
      <line x1="60" y1="192" x2="420" y2="192" stroke="#d1fae5" strokeWidth="2.5" />
      {/* Points de la timeline */}
      {[
        { x: 100, label: "2024", sublabel: "Décret", color: "#059669", active: true },
        { x: 190, label: "2025", sublabel: "Réception", color: "#059669", active: true },
        { x: 280, label: "2026", sublabel: "Émission GE", color: "#d97706", active: false },
        { x: 370, label: "2027", sublabel: "PME/Micro", color: "#94a3b8", active: false },
      ].map((pt) => (
        <g key={pt.x}>
          <circle cx={pt.x} cy={192} r={pt.active ? 9 : 7} fill={pt.color} opacity={pt.active ? 1 : 0.4} />
          {pt.active && <circle cx={pt.x} cy={192} r={14} fill={pt.color} opacity={0.15} />}
          <text x={pt.x} y={212} textAnchor="middle" fill={pt.color} fontSize="10" fontWeight="700" fontFamily="system-ui" opacity={pt.active ? 1 : 0.5}>{pt.label}</text>
          <text x={pt.x} y={225} textAnchor="middle" fill="#94a3b8" fontSize="8.5" fontFamily="system-ui">{pt.sublabel}</text>
        </g>
      ))}
      {/* Progress fill */}
      <line x1="60" y1="192" x2="235" y2="192" stroke="#059669" strokeWidth="2.5" />

      {/* ── Carte "Archivage fiscal 6 ans" ── */}
      <rect x="46" y="52" width="164" height="110" rx="14" fill="white" stroke="#d1fae5" strokeWidth="1.5" />
      {/* Icône dossier */}
      <rect x="62" y="68" width="40" height="30" rx="6" fill="#059669" opacity="0.15" />
      <rect x="62" y="62" width="22" height="10" rx="5" fill="#059669" opacity="0.15" />
      <rect x="66" y="72" width="14" height="2" rx="1" fill="#059669" opacity="0.6" />
      <rect x="66" y="78" width="20" height="2" rx="1" fill="#059669" opacity="0.4" />
      <rect x="66" y="84" width="16" height="2" rx="1" fill="#059669" opacity="0.4" />
      {/* Texte */}
      <text x="116" y="78" fill="#0f172a" fontSize="20" fontWeight="800" fontFamily="system-ui">6 ans</text>
      <text x="116" y="92" fill="#64748b" fontSize="10" fontFamily="system-ui">Archivage fiscal</text>
      <text x="116" y="104" fill="#94a3b8" fontSize="9" fontFamily="system-ui">Art. L102B LPF</text>
      {/* Barre verte */}
      <rect x="62" y="120" width="136" height="6" rx="3" fill="#d1fae5" />
      <rect x="62" y="120" width="90" height="6" rx="3" fill="#059669" />
      <text x="62" y="144" fill="#059669" fontSize="9" fontWeight="600" fontFamily="system-ui">Conforme</text>
      <circle cx="145" cy="140" r="8" fill="#059669" opacity="0.15" />
      <path d="M140 140 L143 143 L150 136" stroke="#059669" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />

      {/* ── Carte "Comptable 10 ans" ── */}
      <rect x="270" y="52" width="164" height="110" rx="14" fill="white" stroke="#dbeafe" strokeWidth="1.5" />
      <rect x="286" y="68" width="40" height="30" rx="6" fill="#1d4ed8" opacity="0.12" />
      <rect x="286" y="62" width="22" height="10" rx="5" fill="#1d4ed8" opacity="0.12" />
      <rect x="290" y="72" width="14" height="2" rx="1" fill="#1d4ed8" opacity="0.5" />
      <rect x="290" y="78" width="20" height="2" rx="1" fill="#1d4ed8" opacity="0.35" />
      <rect x="290" y="84" width="16" height="2" rx="1" fill="#1d4ed8" opacity="0.35" />
      <text x="340" y="78" fill="#0f172a" fontSize="20" fontWeight="800" fontFamily="system-ui">10 ans</text>
      <text x="340" y="92" fill="#64748b" fontSize="10" fontFamily="system-ui">Archivage compta</text>
      <text x="340" y="104" fill="#94a3b8" fontSize="9" fontFamily="system-ui">Art. L123-22 Code comm.</text>
      <rect x="286" y="120" width="136" height="6" rx="3" fill="#dbeafe" />
      <rect x="286" y="120" width="136" height="6" rx="3" fill="#1d4ed8" />
      <text x="286" y="144" fill="#1d4ed8" fontSize="9" fontWeight="600" fontFamily="system-ui">Politique active</text>
      <circle cx="369" cy="140" r="8" fill="#1d4ed8" opacity="0.12" />
      <path d="M364 140 L367 143 L374 136" stroke="#1d4ed8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />

      {/* ── Carte journal d'audit ── */}
      <rect x="140" y="242" width="200" height="90" rx="14" fill="white" stroke="#e2e8f0" strokeWidth="1.5" />
      <text x="156" y="262" fill="#0f172a" fontSize="10" fontWeight="700" fontFamily="system-ui">Journal d'audit</text>
      {[
        { label: "FX-2849 · Créé", time: "14:02", color: "#059669" },
        { label: "FX-2849 · Validé XSD", time: "14:03", color: "#1d4ed8" },
        { label: "FX-2849 · Transmis PA", time: "14:04", color: "#7c3aed" },
      ].map((row, i) => (
        <g key={i}>
          <circle cx="156" cy={278 + i * 16} r="3.5" fill={row.color} />
          <text x="166" y={282 + i * 16} fill="#334155" fontSize="8.5" fontFamily="monospace">{row.label}</text>
          <text x="318" y={282 + i * 16} fill="#94a3b8" fontSize="8" fontFamily="system-ui">{row.time}</text>
        </g>
      ))}

      {/* ── Bouclier central ── */}
      <path d="M240 178 L240 208 C240 218 248 224 248 224 C248 224 256 218 256 208 L256 178 L240 178Z"
        fill="none" stroke="#059669" strokeWidth="2" opacity="0.4" />

      {/* Connecteurs */}
      <line x1="210" y1="162" x2="222" y2="192" stroke="#059669" strokeWidth="1" strokeDasharray="3 3" opacity="0.4" />
      <line x1="270" y1="162" x2="258" y2="192" stroke="#1d4ed8" strokeWidth="1" strokeDasharray="3 3" opacity="0.4" />
      <line x1="240" y1="210" x2="240" y2="242" stroke="#64748b" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────
   SecurityIllustration — fond sombre
   ───────────────────────────────────────────────────────── */
export function SecurityIllustration() {
  return (
    <svg viewBox="0 0 520 390" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      {/* Fond */}
      <rect width="520" height="390" rx="18" fill="#080f20" />

      {/* Grille hexagonale légère */}
      {Array.from({ length: 8 }).map((_, row) =>
        Array.from({ length: 12 }).map((_, col) => (
          <circle key={`${row}-${col}`} cx={26 + col * 44} cy={26 + row * 44} r="1" fill="#1e3a5f" />
        ))
      )}

      {/* ── Rack serveur gauche ── */}
      <rect x="36" y="90" width="110" height="200" rx="10" fill="#0d1f3c" stroke="#1e3a5f" strokeWidth="1.2" />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <g key={i}>
          <rect x="46" y={100 + i * 21} width="90" height="16" rx="4" fill="#0a1628" stroke="#1e3a5f" strokeWidth="1" />
          <circle cx="58" cy={108 + i * 21} r="3" fill={i < 6 ? "#10b981" : "#1e3a5f"} opacity={i < 6 ? 0.9 : 0.4} />
          <rect x="66" y={104 + i * 21} width="50" height="3" rx="1.5" fill="#1e3a5f" />
          <rect x="66" y={110 + i * 21} width="35" height="2.5" rx="1.2" fill="#162540" />
          {i < 4 && <circle cx="126" cy={108 + i * 21} r="2.5" fill="#3b82f6" opacity="0.7" />}
        </g>
      ))}
      <text x="91" y="311" textAnchor="middle" fill="#1e3a5f" fontSize="9" fontFamily="monospace">Cloud UE/EEE</text>

      {/* ── Rack serveur droit ── */}
      <rect x="374" y="90" width="110" height="200" rx="10" fill="#0d1f3c" stroke="#1e3a5f" strokeWidth="1.2" />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <g key={i}>
          <rect x="384" y={100 + i * 21} width="90" height="16" rx="4" fill="#0a1628" stroke="#1e3a5f" strokeWidth="1" />
          <circle cx="396" cy={108 + i * 21} r="3" fill={i < 5 ? "#10b981" : "#1e3a5f"} opacity={i < 5 ? 0.8 : 0.4} />
          <rect x="404" y={104 + i * 21} width="50" height="3" rx="1.5" fill="#1e3a5f" />
          <rect x="404" y={110 + i * 21} width="30" height="2.5" rx="1.2" fill="#162540" />
          {i < 3 && <circle cx="464" cy={108 + i * 21} r="2.5" fill="#6366f1" opacity="0.7" />}
        </g>
      ))}
      <text x="429" y="311" textAnchor="middle" fill="#1e3a5f" fontSize="9" fontFamily="monospace">Backup · EU</text>

      {/* ── Bouclier central ── */}
      {/* Halo externe */}
      <circle cx="260" cy="195" r="85" fill="#1d4ed8" opacity="0.04" />
      <circle cx="260" cy="195" r="68" fill="#1d4ed8" opacity="0.06" />
      <circle cx="260" cy="195" r="52" fill="#1d4ed8" opacity="0.1" />
      {/* Forme shield */}
      <path d="M260 138 L294 152 L294 188 C294 212 278 230 260 238 C242 230 226 212 226 188 L226 152 Z"
        fill="#0d1f3c" stroke="#3b82f6" strokeWidth="1.8" />
      {/* Inner shine */}
      <path d="M260 145 L289 157 L289 188 C289 209 275 225 260 233 C245 225 231 209 231 188 L231 157 Z"
        fill="url(#shieldGrad)" opacity="0.15" />
      {/* Lock icon */}
      <rect x="250" y="180" width="20" height="16" rx="3" fill="#3b82f6" opacity="0.9" />
      <path d="M254 180 L254 175 C254 171.7 257.4 169 260 169 C262.6 169 266 171.7 266 175 L266 180"
        stroke="#3b82f6" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <circle cx="260" cy="188" r="2.5" fill="white" opacity="0.8" />

      {/* ── Lignes réseau ── */}
      {/* Gauche → Shield */}
      <line x1="146" y1="150" x2="225" y2="172" stroke="#1e3a5f" strokeWidth="1.2" strokeDasharray="5 3" />
      <line x1="146" y1="195" x2="225" y2="195" stroke="#1e3a5f" strokeWidth="1.2" strokeDasharray="5 3" />
      <line x1="146" y1="240" x2="225" y2="218" stroke="#1e3a5f" strokeWidth="1.2" strokeDasharray="5 3" />
      {/* Droite → Shield */}
      <line x1="374" y1="150" x2="295" y2="172" stroke="#1e3a5f" strokeWidth="1.2" strokeDasharray="5 3" />
      <line x1="374" y1="195" x2="295" y2="195" stroke="#1e3a5f" strokeWidth="1.2" strokeDasharray="5 3" />
      <line x1="374" y1="240" x2="295" y2="218" stroke="#1e3a5f" strokeWidth="1.2" strokeDasharray="5 3" />

      {/* Noeuds de connexion animés (petits cercles lumineux) */}
      {[
        { x: 165, y: 150, c: "#10b981" }, { x: 165, y: 195, c: "#3b82f6" }, { x: 165, y: 240, c: "#10b981" },
        { x: 355, y: 150, c: "#6366f1" }, { x: 355, y: 195, c: "#3b82f6" }, { x: 355, y: 240, c: "#10b981" },
      ].map((node, i) => (
        <g key={i}>
          <circle cx={node.x} cy={node.y} r="8" fill={node.c} opacity="0.08" />
          <circle cx={node.x} cy={node.y} r="4" fill={node.c} opacity="0.5" />
          <circle cx={node.x} cy={node.y} r="2" fill={node.c} />
        </g>
      ))}

      {/* ── Badges TLS / AES / RGPD ── */}
      {[
        { x: 174, y: 334, label: "TLS 1.3", color: "#3b82f6" },
        { x: 260, y: 334, label: "AES-256", color: "#10b981" },
        { x: 346, y: 334, label: "RGPD · DPA", color: "#6366f1" },
      ].map((badge) => (
        <g key={badge.x}>
          <rect x={badge.x - 36} y="322" width="72" height="24" rx="8"
            fill={badge.color} fillOpacity="0.1" stroke={badge.color} strokeOpacity="0.3" strokeWidth="1" />
          <text x={badge.x} y="337" textAnchor="middle" fill={badge.color} fontSize="9" fontWeight="700" fontFamily="system-ui">{badge.label}</text>
        </g>
      ))}

      {/* ── Chiffres de disponibilité ── */}
      <text x="260" y="68" textAnchor="middle" fill="#1e3a5f" fontSize="9" fontWeight="600" fontFamily="system-ui" letterSpacing="3">
        99.9% · UPTIME · MONITORING 24/7
      </text>
      <line x1="140" y1="72" x2="196" y2="72" stroke="#1e3a5f" strokeWidth="1" />
      <line x1="324" y1="72" x2="380" y2="72" stroke="#1e3a5f" strokeWidth="1" />

      {/* Gradient def */}
      <defs>
        <linearGradient id="shieldGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity="0.4" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────
   WorkflowIllustration — FeaturesPage header (fond clair)
   ───────────────────────────────────────────────────────── */
export function WorkflowIllustration() {
  const steps = [
    { x: 60,  label: "Produire",    sub: "Clients · TVA · lignes", color: "#1d4ed8", bg: "#dbeafe" },
    { x: 195, label: "Contrôler",   sub: "XSD · cohérence", color: "#7c3aed", bg: "#ede9fe" },
    { x: 330, label: "Transmettre", sub: "PA · Factur-X", color: "#059669", bg: "#d1fae5" },
    { x: 465, label: "Tracer",      sub: "Audit · journal", color: "#d97706", bg: "#fef3c7" },
  ];

  return (
    <svg viewBox="0 0 580 320" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      {/* Fond */}
      <rect width="580" height="320" rx="20" fill="#f8fafc" />

      {/* Points de grille */}
      {Array.from({ length: 8 }).map((_, row) =>
        Array.from({ length: 15 }).map((_, col) => (
          <circle key={`${row}-${col}`} cx={18 + col * 40} cy={18 + row * 40} r="1.2" fill="#e2e8f0" />
        ))
      )}

      {/* ── Ligne de connexion centrale ── */}
      <line x1="100" y1="110" x2="480" y2="110" stroke="#e2e8f0" strokeWidth="2" strokeDasharray="6 4" />

      {/* ── Étapes ── */}
      {steps.map((s, i) => (
        <g key={i}>
          {/* Cercle principal */}
          <circle cx={s.x + 55} cy={110} r={32} fill={s.bg} />
          <circle cx={s.x + 55} cy={110} r={22} fill={s.color} />
          {/* Numéro */}
          <text x={s.x + 55} y={115} textAnchor="middle" fill="white" fontSize="14" fontWeight="800" fontFamily="system-ui">{i + 1}</text>

          {/* Flèche entre étapes */}
          {i < 3 && (
            <g>
              <line x1={s.x + 90} y1={110} x2={s.x + 120} y2={110} stroke={s.color} strokeWidth="2" opacity="0.5" />
              <polygon points={`${s.x + 118},106 ${s.x + 126},110 ${s.x + 118},114`} fill={s.color} opacity="0.5" />
            </g>
          )}

          {/* Carte texte */}
          <rect x={s.x + 10} y={155} width={90} height={58} rx="10" fill="white" stroke="#e2e8f0" strokeWidth="1.2" />
          <text x={s.x + 55} y={174} textAnchor="middle" fill={s.color} fontSize="10" fontWeight="700" fontFamily="system-ui">{s.label}</text>
          <text x={s.x + 55} y={188} textAnchor="middle" fill="#94a3b8" fontSize="8.5" fontFamily="system-ui">{s.sub.split(" · ")[0]}</text>
          <text x={s.x + 55} y={199} textAnchor="middle" fill="#94a3b8" fontSize="8.5" fontFamily="system-ui">{s.sub.split(" · ")[1] || ""}</text>

          {/* Ligne verticale */}
          <line x1={s.x + 55} y1={142} x2={s.x + 55} y2={155} stroke={s.color} strokeWidth="1.5" strokeDasharray="3 2" opacity="0.5" />
        </g>
      ))}

      {/* ── Carte Factur-X (en haut) ── */}
      <rect x="185" y="24" width="125" height="50" rx="11" fill="white" stroke="#e0e7ff" strokeWidth="1.5" />
      <rect x="196" y="34" width="30" height="30" rx="7" fill="#eef2ff" />
      <text x="211" y="53" textAnchor="middle" fill="#4f46e5" fontSize="11" fontWeight="800" fontFamily="monospace">&lt;/&gt;</text>
      <rect x="232" y="38" width="66" height="5" rx="2.5" fill="#e0e7ff" />
      <rect x="232" y="48" width="48" height="4" rx="2" fill="#f1f5f9" />
      <rect x="232" y="57" width="56" height="4" rx="2" fill="#dbeafe" />
      {/* Ligne vers étape 1 */}
      <line x1="247" y1="74" x2="247" y2="87" stroke="#6366f1" strokeWidth="1.5" strokeDasharray="3 2" opacity="0.5" />

      {/* ── Badge validation ── */}
      <rect x="325" y="24" width="110" height="50" rx="11" fill="white" stroke="#d1fae5" strokeWidth="1.5" />
      <circle cx="343" cy="49" r="16" fill="#059669" opacity="0.12" />
      <circle cx="343" cy="49" r="10" fill="#059669" />
      <path d="M337 49 L341 53 L350 43" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="358" y="34" width="68" height="5" rx="2.5" fill="#d1fae5" />
      <rect x="358" y="44" width="52" height="4" rx="2" fill="#f0fdf4" />
      <rect x="358" y="53" width="40" height="4" rx="2" fill="#d1fae5" />
      {/* Ligne vers étape 3 */}
      <line x1="385" y1="74" x2="385" y2="87" stroke="#059669" strokeWidth="1.5" strokeDasharray="3 2" opacity="0.5" />

      {/* ── Légende bas ── */}
      <rect x="140" y="248" width="300" height="44" rx="12" fill="white" stroke="#e2e8f0" strokeWidth="1" />
      <text x="290" y="267" textAnchor="middle" fill="#64748b" fontSize="9" fontWeight="600" fontFamily="system-ui" letterSpacing="2">FACTUR-X · EN16931 · CII · UBL</text>
      <text x="290" y="282" textAnchor="middle" fill="#94a3b8" fontSize="8.5" fontFamily="system-ui">Préparation réforme 2026</text>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────
   TrustIllustration — ConfiancePage (dark header)
   ───────────────────────────────────────────────────────── */
export function TrustIllustration() {
  const pillars = [
    { x: 60,  label: "Sécurité",   icon: "🔒", color: "#3b82f6" },
    { x: 175, label: "RGPD",       icon: "🛡",  color: "#10b981" },
    { x: 290, label: "Archivage",  icon: "📂",  color: "#f59e0b" },
    { x: 405, label: "Légal",      icon: "📋",  color: "#a78bfa" },
  ];

  return (
    <svg viewBox="0 0 530 280" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
      {/* Fond */}
      <rect width="530" height="280" rx="18" fill="#080f20" />

      {/* Grille */}
      {Array.from({ length: 7 }).map((_, row) =>
        Array.from({ length: 13 }).map((_, col) => (
          <circle key={`${row}-${col}`} cx={22 + col * 42} cy={22 + row * 42} r="1" fill="#1e3a5f" />
        ))
      )}

      {/* Arc central */}
      <path d="M265 60 L265 180 C265 210 265 210 265 210" stroke="#1e3a5f" strokeWidth="1" strokeDasharray="4 4" />

      {/* Piliers */}
      {pillars.map((p, i) => (
        <g key={i}>
          <rect x={p.x} y="80" width="90" height="120" rx="12" fill="#0d1f3c" stroke="#1e3a5f" strokeWidth="1.2" />
          <rect x={p.x + 10} y="90" width="70" height="40" rx="8" fill={p.color} opacity="0.12" />
          <text x={p.x + 45} y="115" textAnchor="middle" fontSize="20" fontFamily="system-ui">{p.icon}</text>
          <text x={p.x + 45} y="143" textAnchor="middle" fill={p.color} fontSize="9.5" fontWeight="700" fontFamily="system-ui">{p.label}</text>
          {/* Barre de progression */}
          <rect x={p.x + 12} y="160" width="66" height="5" rx="2.5" fill="#1e3a5f" />
          <rect x={p.x + 12} y="160" width={40 + i * 8} height="5" rx="2.5" fill={p.color} opacity="0.7" />
          {/* Check */}
          <circle cx={p.x + 45} cy={185} r="7" fill={p.color} opacity="0.2" />
          <circle cx={p.x + 45} cy={185} r="4" fill={p.color} opacity="0.6" />
        </g>
      ))}

      {/* Ligne de connexion en haut */}
      <line x1="105" y1="80" x2="175" y2="80" stroke="#1e3a5f" strokeWidth="1" strokeDasharray="4 3" />
      <line x1="265" y1="80" x2="310" y2="80" stroke="#1e3a5f" strokeWidth="1" strokeDasharray="4 3" />
      <line x1="220" y1="80" x2="265" y2="80" stroke="#1e3a5f" strokeWidth="1" strokeDasharray="4 3" />
      <line x1="375" y1="80" x2="405" y2="80" stroke="#1e3a5f" strokeWidth="1" strokeDasharray="4 3" />

      {/* ── Badge Hébergeur de l'instance · France ── */}
      <rect x="150" y="222" width="230" height="38" rx="10" fill="#0d1f3c" stroke="#1e3a5f" strokeWidth="1" />
      <text x="265" y="238" textAnchor="middle" fill="#3b82f6" fontSize="9" fontWeight="700" fontFamily="system-ui" letterSpacing="2">HEBERGEMENT UE/EEE</text>
      <text x="265" y="251" textAnchor="middle" fill="#1e3a5f" fontSize="8" fontFamily="system-ui">TLS 1.3 · AES-256 · DPA RGPD art.28</text>

      {/* Badges flottants */}
      <rect x="30" y="220" width="92" height="28" rx="8" fill="#059669" opacity="0.15" stroke="#059669" strokeOpacity="0.3" strokeWidth="1" />
      <text x="76" y="237" textAnchor="middle" fill="#10b981" fontSize="9" fontWeight="700" fontFamily="system-ui">6 ans · fiscal</text>

      <rect x="408" y="220" width="92" height="28" rx="8" fill="#a78bfa" opacity="0.1" stroke="#a78bfa" strokeOpacity="0.3" strokeWidth="1" />
      <text x="454" y="237" textAnchor="middle" fill="#a78bfa" fontSize="9" fontWeight="700" fontFamily="system-ui">DPA art. 28</text>
    </svg>
  );
}
