import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LibrarySidebarContent } from "./LibrarySidebar";
import ProjectsSection from "./ProjectsSection";

const projects = [
  { id: 1, name: "Client pitch", memberCount: 12, archived: false },
  { id: 2, name: "Old trailer", memberCount: 1, archived: true },
  { id: 3, name: "Moodboard", memberCount: 0, archived: false },
];

function renderSection(props = {}) {
  const handlers = {
    onOpenProject: vi.fn(),
    onCreateProject: vi.fn().mockResolvedValue({ id: 4 }),
    onRenameProject: vi.fn().mockResolvedValue({ id: 1 }),
    onSetProjectArchived: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenamingProjectChange: vi.fn(),
  };
  const utils = render(
    <ProjectsSection projects={projects} {...handlers} {...props} />
  );
  return { ...utils, handlers };
}

describe("ProjectsSection", () => {
  it("lists active projects with counts and hides archived ones", () => {
    renderSection({ activeProjectId: 1 });
    const open = screen.getByRole("button", { name: /^Client pitch/ });
    expect(open).toHaveTextContent("12 clips");
    expect(open).toHaveAttribute("aria-current", "location");
    expect(screen.getByRole("button", { name: /^Moodboard/ })).toHaveTextContent(
      "0 clips"
    );
    expect(screen.queryByText("Old trailer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show archived (1)" }));
    const archive = screen.getByRole("list", { name: "Archived projects" });
    expect(within(archive).getByText("Old trailer")).toBeInTheDocument();
  });

  it("opens a project", () => {
    const { handlers } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: /^Moodboard/ }));
    expect(handlers.onOpenProject).toHaveBeenCalledWith(projects[2]);
  });

  it("creates a project from the name form", async () => {
    const { handlers } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("New project name"), {
      target: { value: "  Spring campaign " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(handlers.onCreateProject).toHaveBeenCalledWith("Spring campaign")
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("New project name")).not.toBeInTheDocument()
    );
  });

  it("keeps the name form open and says why when a name is refused", async () => {
    const { handlers } = renderSection();
    handlers.onCreateProject.mockRejectedValueOnce(
      new Error('A project named "Moodboard" already exists')
    );
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("New project name"), {
      target: { value: "moodboard" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/);
    expect(screen.getByLabelText("New project name")).toBeInTheDocument();
  });

  it("archives and asks before deleting", async () => {
    const { handlers } = renderSection();
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for project Client pitch" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(handlers.onSetProjectArchived).toHaveBeenCalledWith(1, true);

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for project Client pitch" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete Client pitch" });
    expect(confirm).toHaveTextContent("The clips themselves are not touched");
    expect(handlers.onDeleteProject).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete project" }));
    await waitFor(() =>
      expect(handlers.onDeleteProject).toHaveBeenCalledWith(1, projects[0])
    );
  });

  it("renames in place when asked to, and closes the field afterwards", async () => {
    const { handlers } = renderSection({ renamingProjectId: 3 });
    const field = screen.getByLabelText("New name for Moodboard");
    fireEvent.change(field, { target: { value: "Mood v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(handlers.onRenameProject).toHaveBeenCalledWith(3, "Mood v2")
    );
    expect(handlers.onRenamingProjectChange).toHaveBeenLastCalledWith(null);
  });

  it("is part of the Library panel only when project props are supplied", () => {
    const { rerender } = render(<LibrarySidebarContent />);
    expect(screen.queryByRole("heading", { name: "Projects" })).not.toBeInTheDocument();
    rerender(<LibrarySidebarContent projectsProps={{ projects }} />);
    expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
  });
});
