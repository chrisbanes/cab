import {
  getFiletypeFromFileName,
  parsePatchFiles,
  setLanguageOverride,
} from "@pierre/diffs";
import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import { useMemo } from "react";
import { bundledLanguages } from "./shiki-langs.js";

/**
 * `FileDiff` for one file's patch, loaded on first use. A language without a bundled grammar is
 * shown as plain text, because the diff library fails to render a language it cannot load.
 */
export default function PierreDiff({
  patch,
  path,
  ...props
}: Omit<FileDiffProps<undefined, undefined>, "fileDiff"> & {
  patch: string;
  path: string;
}) {
  const fileDiff = useMemo(() => {
    const file = parsePatchFiles(patch)[0]?.files[0];
    if (!file) return undefined;
    const lang = getFiletypeFromFileName(path);
    return setLanguageOverride(
      file,
      Object.hasOwn(bundledLanguages, lang) ? lang : "text",
    );
  }, [patch, path]);
  return fileDiff ? <FileDiff fileDiff={fileDiff} {...props} /> : null;
}
