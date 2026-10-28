import { en } from "./en";
import type { Messages } from "./fa";
import { fa } from "./fa";

export type { Messages };
export type { CustomizeData, MenuData, MenuLine, StatusData } from "./fa";

export function messages(language: string | null | undefined): Messages {
  return language === "en" ? en : fa;
}
