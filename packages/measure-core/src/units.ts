/** Secondary display: feet and inches from metres (PRD FR-25). */
export function metresToFeetInches(m: number): string {
  const totalIn = Math.round(m / 0.0254);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn % 12;
  return `${ft}' ${inch}"`;
}

export function formatLengthDual(
  metres: number | null,
  primary: "metric" | "imperial",
): { primary: string; secondary: string } {
  if (metres === null)
    return { primary: "—", secondary: primary === "metric" ? "—" : "—" };
  if (primary === "metric") {
    return {
      primary: `${metres.toFixed(2)} m`,
      secondary: `≈ ${metresToFeetInches(metres)}`,
    };
  }
  return {
    primary: metresToFeetInches(metres),
    secondary: `≈ ${metres.toFixed(2)} m`,
  };
}
