import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { ErrorBox, Icon, Loading, errMsg } from "../ui.tsx";
import { day, unitLabel } from "../util.ts";

interface Row {
  row: number;
  sku: string;
  name: string;
  unit: string;
}

/** Printable count sheet. Row numbers and SKUs are printed large so OCR can anchor each line. */
export function PrintSheet() {
  const [data, setData] = useState<{ date: string; rows: Row[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ date: string; rows: Row[] }>("/count/sheet").then(setData).catch((e) => setError(errMsg(e)));
  }, []);
  if (error) return <div className="app"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  return (
    <div className="app" style={{ paddingBottom: 24 }}>
      <div className="row between no-print" style={{ marginBottom: 16 }}>
        <a className="btn ghost sm" href="#/count">
          <Icon name="back" /> Back
        </a>
        <button className="btn primary" onClick={() => print()}>
          <Icon name="print" /> Print
        </button>
      </div>
      <div className="print-sheet">
        <div className="row between" style={{ marginBottom: 10 }}>
          <h1>PACKAGING DAILY COUNT</h1>
          <div style={{ fontSize: 14 }}>
            Date: <strong>{day(data.date)}</strong> &nbsp; Counted by: ________________
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>SKU</th>
              <th>Item</th>
              <th>Unit</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.sku}>
                <td className="no">{r.row}</td>
                <td className="sku">{r.sku}</td>
                <td>{r.name}</td>
                <td style={{ width: 44 }}>{unitLabel(r.unit).toUpperCase()}</td>
                <td className="box" />
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 11, marginTop: 8 }}>Write one clear number per box. Cross out mistakes and write the correct number beside them. Leave blank if not counted.</p>
      </div>
    </div>
  );
}
