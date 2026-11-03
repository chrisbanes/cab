import { createContext, useContext } from "react";
import { type RepositoryNames, repositoryLabel } from "./presentation.js";

/** The task workspace's linked repositories with their verified names; display only, IDs stay the identity. */
export const RepositoryNamesContext = createContext<
  RepositoryNames | undefined
>(undefined);

/** Labels a repository by its verified `owner/name`, falling back to its ID. */
export function useRepositoryLabel() {
  const names = useContext(RepositoryNamesContext);
  return (repositoryId: string) => repositoryLabel(repositoryId, names);
}
