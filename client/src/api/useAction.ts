import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast';

/**
 * Runs a change against the API. On success it refetches every query on screen — counts, fill
 * states, the alert badge and timelines all move together, and at this size refetching everything
 * is cheaper than tracking which views a change affects. On failure it shows the server's reason.
 */
export function useAction<Input = void, Result = unknown>(
  run: (input: Input) => Promise<Result>,
  options: { success?: string | ((result: Result) => string); onSuccess?: (result: Result) => void } = {},
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: run,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      const message = typeof options.success === 'function' ? options.success(result) : options.success;
      if (message) toast(message);
      options.onSuccess?.(result);
    },
    onError: (error) => toast(error.message, 'error'),
  });
}
