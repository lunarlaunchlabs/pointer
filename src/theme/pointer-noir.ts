import { pointerThemeFor } from "@/theme/themes";

export const POINTER_NOIR_ID = "pointer-noir";

const pointerNoir = pointerThemeFor(POINTER_NOIR_ID);

export const pointerNoirTheme = pointerNoir.monaco;
export const pointerNoirShikiTheme = pointerNoir.shiki;
