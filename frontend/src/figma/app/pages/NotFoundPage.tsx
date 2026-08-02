"use client";
import { motion } from "motion/react";
import { Link } from "@/figma/react-router-compat";
import { ArrowLeft, Home } from "lucide-react";
import { LegalLayout } from "../components/landing/LegalLayout";

export function NotFoundPage() {
  return (
    <LegalLayout>
      <div className="flex flex-col items-center justify-center py-32 px-6 text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        >
          <div
            className="text-[120px] font-black leading-none mb-4 tracking-tighter"
            style={{
              background: "linear-gradient(135deg, #e2e8f0, #f1f5f9)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            404
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.6 }}
          className="flex flex-col items-center gap-4"
        >
          <h1 className="text-[28px] font-bold text-slate-900">Page introuvable</h1>
          <p className="text-[15px] text-slate-500 max-w-sm leading-relaxed">
            La ressource demandée n'existe pas ou a été déplacée. Vérifiez l'URL ou revenez à l'accueil.
          </p>

          <div className="flex flex-wrap gap-3 mt-4">
            <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}>
              <Link
                to="/"
                className="inline-flex items-center gap-2 text-white px-6 py-3 rounded-xl text-[14px] font-semibold"
                style={{ background: "linear-gradient(135deg, #1d4ed8, #3b82f6)" }}
              >
                <Home size={15} /> Retour à l'accueil
              </Link>
            </motion.div>
            <button
              onClick={() => window.history.back()}
              className="inline-flex items-center gap-2 bg-white border border-slate-200 text-slate-700 px-6 py-3 rounded-xl text-[14px] font-medium cursor-pointer hover:bg-slate-50 transition-colors"
            >
              <ArrowLeft size={15} /> Page précédente
            </button>
          </div>
        </motion.div>
      </div>
    </LegalLayout>
  );
}
