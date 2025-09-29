import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import Gate from './Gate';

const mockUseActiveStoreContext = vi.fn();
const mockUseMemberships = vi.fn();

vi.mock('../context/ActiveStoreProvider', () => ({
  useActiveStoreContext: () => mockUseActiveStoreContext(),
}));

vi.mock('../hooks/useMemberships', () => ({
  useMemberships: (storeId?: string | null) => mockUseMemberships(storeId),
}));

describe('Gate', () => {
  beforeEach(() => {
    mockUseActiveStoreContext.mockReset();
    mockUseMemberships.mockReset();
    mockUseActiveStoreContext.mockReturnValue({ storeId: 'store-1', isLoading: false, error: null });
  });

  it('renders a loading state while memberships are loading', () => {
    mockUseMemberships.mockImplementation(storeId => ({
      storeId,
      loading: true,
      error: null,
    }));

    render(<Gate />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders an error message when memberships can't be fetched", () => {
    const error = new Error('Failed to load memberships');
    mockUseMemberships.mockReturnValue({ loading: false, error });

    render(<Gate />);

    expect(screen.getByRole('heading', { name: /couldn't load your workspace/i })).toBeInTheDocument();
    expect(screen.getByText(/failed to load memberships/i)).toBeInTheDocument();
  });

  it('renders children once memberships load successfully', () => {
    mockUseMemberships.mockReturnValue({ loading: false, error: null });
    const child = <div data-testid="app">App</div>;

    render(<Gate>{child}</Gate>);

    expect(screen.getByTestId('app')).toBeInTheDocument();
  });
});
