export type PedagogyMode = "explanatory" | "concise";

export interface PedagogyModeInfo {
  id: PedagogyMode;
  name: string;
  description: string;
  icon: string;
  color: string;
}

export const PEDAGOGY_MODES: PedagogyModeInfo[] = [
  {
    id: "explanatory",
    name: "General Chat",
    description: "Clear explanations with examples for concept learning",
    icon: "📖",
    color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  },
  {
    id: "concise",
    name: "Code Assistant",
    description: "Short, direct coding guidance and edit support",
    icon: "🧩",
    color: "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-200",
  },
];
