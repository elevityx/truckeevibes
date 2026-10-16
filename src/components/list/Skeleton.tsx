/** A placeholder row while the first read is pending (canvas .sk). Decorative. */
export default function Skeleton() {
  return (
    <div className="drow sk-row" aria-hidden="true">
      <span className="sk" style={{ width: '40%' }} />
      <span className="sk t" />
      <span className="sk" style={{ width: '55%' }} />
    </div>
  );
}
