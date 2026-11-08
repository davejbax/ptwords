/** Search key: lowercase, accents stripped. Must match norm() in scripts/build_dict.py. */
export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").trim();
