import { Button } from './ui';

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm" aria-label="Pagination">
      <p className="text-muted">
        {total === 0 ? 'No matching shifts' : `Showing ${first}–${last} of ${total} matching shifts`}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="tabular-nums text-muted">
          Page {page} of {totalPages}
        </span>
        <Button size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </nav>
  );
}
