// Process is alive. No dependencies checked.
export function GET() {
  return Response.json({ status: 'alive' });
}
