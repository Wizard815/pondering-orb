export const EditButton = ({ editing, setEditing }: { editing: boolean; setEditing: (b: boolean) => void }) =>
  <button className={"btn" + (editing ? " primary" : "")} onClick={() => setEditing(!editing)}>{editing ? "Done editing" : "Edit layout"}</button>;
