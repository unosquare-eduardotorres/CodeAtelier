import { useState } from 'react';
import { Plus, Pencil, Trash2, FileText, PenLine } from 'lucide-react';
import { useSpecialistStore, useSkillStore } from '@renderer/store';
import { ConfirmDialog } from '@renderer/components/common';
import SpecialistForm from './SpecialistForm';
import type { Specialist } from '../../../../shared/types';

export default function SpecialistsList(): React.JSX.Element {
  const { specialists, isLoading, deleteSpecialist } = useSpecialistStore();
  const { skills } = useSkillStore();
  const [editingSpecialist, setEditingSpecialist] = useState<Specialist | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const sortedSpecialists = [...specialists].sort((a, b) => a.priority - b.priority);

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    const result = await deleteSpecialist(deleteTarget);
    if (result.success) {
      setDeleteTarget(null);
      setDeleteError(null);
    } else {
      setDeleteError(result.error ?? 'Failed to delete specialist');
    }
  };

  const handleEdit = (specialist: Specialist): void => {
    setEditingSpecialist(specialist);
    setShowForm(true);
  };

  const handleCloseForm = (): void => {
    setShowForm(false);
    setEditingSpecialist(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-400" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {/* Section header */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Specialists</h3>
            <p className="text-xs text-gray-500 mt-1">
              Manage AI specialist agents and their routing priorities
            </p>
          </div>
          <button
            onClick={() => {
              setEditingSpecialist(null);
              setShowForm(true);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
          >
            <Plus size={14} />
            Add Specialist
          </button>
        </div>

        {/* Specialists list */}
        {sortedSpecialists.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-gray-500 mb-1">No specialists configured</p>
            <p className="text-xs text-gray-600">Add a specialist to get started</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedSpecialists.map((specialist) => (
              <div
                key={specialist.id}
                className="group bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 hover:border-gray-600/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {/* Icon */}
                  <div
                    className="flex items-center justify-center w-10 h-10 rounded-lg text-lg"
                    style={{ backgroundColor: `${specialist.color}20` }}
                  >
                    {specialist.icon}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-200">
                        {specialist.displayName}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
                          specialist.isActive
                            ? 'bg-green-500/10 text-green-400'
                            : 'bg-gray-600/30 text-gray-500'
                        }`}
                      >
                        {specialist.isActive ? 'Active' : 'Inactive'}
                      </span>
                      {specialist.sourceYaml ? (
                        <span
                          className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-blue-500/10 text-blue-400"
                          title={`Synced from ${specialist.sourceYaml}`}
                        >
                          <FileText size={9} />
                          YAML
                        </span>
                      ) : (
                        <span
                          className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-gray-600/20 text-gray-500"
                          title="Manually created"
                        >
                          <PenLine size={9} />
                          Manual
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[10px] text-gray-500">
                        Priority: {specialist.priority}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        ID: {specialist.agentId}
                      </span>
                      {specialist.skills && specialist.skills.length > 0 && (
                        <div className="flex items-center gap-1">
                          {specialist.skills.map((skill) => (
                            <span
                              key={skill.id}
                              className="px-1.5 py-0.5 text-[10px] rounded-full bg-indigo-500/10 text-indigo-400 font-medium"
                            >
                              {skill.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Color swatch */}
                  <div
                    className="w-4 h-4 rounded-full flex-shrink-0 border border-gray-600"
                    style={{ backgroundColor: specialist.color }}
                    title={specialist.color}
                  />

                  {/* Actions */}
                  <div className="flex items-center gap-1 transition-opacity">
                    <button
                      onClick={() => handleEdit(specialist)}
                      className="p-1.5 rounded-md hover:bg-gray-700 text-gray-500 hover:text-gray-300 transition-colors"
                      aria-label={`Edit ${specialist.displayName}`}
                      title="Edit specialist"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTarget(specialist.id);
                      }}
                      className="p-1.5 rounded-md hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors"
                      aria-label={`Delete ${specialist.displayName}`}
                      title="Delete specialist"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Specialist form modal */}
      {showForm && (
        <SpecialistForm
          specialist={editingSpecialist}
          skills={skills}
          onClose={handleCloseForm}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Specialist"
        message={
          deleteError
            ? deleteError
            : 'Are you sure you want to delete this specialist? This action cannot be undone.'
        }
        confirmLabel={deleteError ? 'Close' : 'Delete'}
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={deleteError ? () => { setDeleteTarget(null); setDeleteError(null); } : handleDelete}
        onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
      />
    </>
  );
}
