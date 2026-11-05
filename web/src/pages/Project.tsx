import { EditButton } from "../components/EditButton";
export function ProjectPage({ id, editing, setEditing }: { id: string; editing: boolean; setEditing: (b: boolean) => void }) {
  return <div className="room"><p className="crumb"><a href="#projects">← Projects</a></p><div className="room-head"><h2>Project {id}</h2><EditButton editing={editing} setEditing={setEditing} /></div><div className="empty">Being ported.</div></div>;
}
