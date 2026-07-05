import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Project } from './api/client';

interface ProjectState {
  projects: Project[];
  current: Project | null;
  setCurrent: (p: Project) => void;
  reload: () => Promise<void>;
}

const Ctx = createContext<ProjectState>(null as unknown as ProjectState);
export const useProject = () => useContext(Ctx);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrentState] = useState<Project | null>(null);

  async function reload() {
    const res = await api.get<{ data: Project[] }>('/api/projects');
    setProjects(res.data);
    const savedId = localStorage.getItem('projectId');
    const next = res.data.find((p) => p.id === savedId) ?? res.data[0] ?? null;
    setCurrentState(next);
  }

  function setCurrent(p: Project) {
    setCurrentState(p);
    localStorage.setItem('projectId', p.id);
  }

  useEffect(() => { void reload(); }, []);

  return (
    <Ctx.Provider value={{ projects, current, setCurrent, reload }}>
      {children}
    </Ctx.Provider>
  );
}
