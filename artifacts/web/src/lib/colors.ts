// Shared funnel-stage color palette. Class strings are written out in full so the
// Tailwind scanner picks them up (no dynamic class construction).
export const STAGE_COLORS = [
  "slate", "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald",
  "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
] as const;

const DOT: Record<string, string> = {
  slate: "bg-slate-400", gray: "bg-gray-400", red: "bg-red-500", orange: "bg-orange-500",
  amber: "bg-amber-500", yellow: "bg-yellow-400", lime: "bg-lime-500", green: "bg-green-500",
  emerald: "bg-emerald-500", teal: "bg-teal-500", cyan: "bg-cyan-500", sky: "bg-sky-500",
  blue: "bg-blue-500", indigo: "bg-indigo-500", violet: "bg-violet-500", purple: "bg-purple-500",
  fuchsia: "bg-fuchsia-500", pink: "bg-pink-500", rose: "bg-rose-500",
};
const TOP: Record<string, string> = {
  slate: "border-t-slate-400", gray: "border-t-gray-400", red: "border-t-red-500", orange: "border-t-orange-500",
  amber: "border-t-amber-500", yellow: "border-t-yellow-400", lime: "border-t-lime-500", green: "border-t-green-500",
  emerald: "border-t-emerald-500", teal: "border-t-teal-500", cyan: "border-t-cyan-500", sky: "border-t-sky-500",
  blue: "border-t-blue-500", indigo: "border-t-indigo-500", violet: "border-t-violet-500", purple: "border-t-purple-500",
  fuchsia: "border-t-fuchsia-500", pink: "border-t-pink-500", rose: "border-t-rose-500",
};

// Soft badge (bg + text) used for position/role chips — written out in full for the scanner.
const BADGE: Record<string, string> = {
  slate: "bg-slate-100 text-slate-700", gray: "bg-gray-100 text-gray-700", red: "bg-red-100 text-red-700", orange: "bg-orange-100 text-orange-700",
  amber: "bg-amber-100 text-amber-700", yellow: "bg-yellow-100 text-yellow-700", lime: "bg-lime-100 text-lime-700", green: "bg-green-100 text-green-700",
  emerald: "bg-emerald-100 text-emerald-700", teal: "bg-teal-100 text-teal-700", cyan: "bg-cyan-100 text-cyan-700", sky: "bg-sky-100 text-sky-700",
  blue: "bg-blue-100 text-blue-700", indigo: "bg-indigo-100 text-indigo-700", violet: "bg-violet-100 text-violet-700", purple: "bg-purple-100 text-purple-700",
  fuchsia: "bg-fuchsia-100 text-fuchsia-700", pink: "bg-pink-100 text-pink-700", rose: "bg-rose-100 text-rose-700",
};

export const dotClass = (c: string) => DOT[c] ?? "bg-slate-300";
export const topClass = (c: string) => TOP[c] ?? "border-t-slate-300";
export const badgeClass = (c: string) => BADGE[c] ?? "bg-slate-100 text-slate-700";

// Gender display helpers — labelled K (kobieta) / M (mężczyzna), per Polish convention.
export const genderIcon = (g?: string | null) => (g === "male" ? "M" : g === "female" ? "K" : "");
export const genderClass = (g?: string | null) => (g === "male" ? "text-sky-600" : g === "female" ? "text-pink-600" : "text-slate-400");
