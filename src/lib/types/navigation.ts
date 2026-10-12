import type { LucideIcon } from "lucide-react";
import type { ModuleAvailability } from "./status";

export interface NavChild {
  title: string;
  href: string;
}

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  description: string;
  availability: ModuleAvailability;
  children?: NavChild[];
}
