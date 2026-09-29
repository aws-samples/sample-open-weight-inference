import Button from '@cloudscape-design/components/button';
import FormField from '@cloudscape-design/components/form-field';
import Select from '@cloudscape-design/components/select';
import { useNavigate } from 'react-router-dom';
import { useCase } from '../state/CaseContext';
import { useConversations } from '../state/ConversationsContext';

export function ProjectSwitcher() {
  const { form } = useCase();
  const { conversations } = useConversations();
  const navigate = useNavigate();
  const options = conversations.map((c) => ({
    value: c.id, label: c.title,
    description: `Last saved or used ${new Date(c.updatedAt).toLocaleString()}`,
  }));
  if (!options.some((o) => o.value === form.caseId)) {
    options.unshift({
      value: form.caseId,
      label: form.description.trim().slice(0, 100) || 'New project',
      description: 'Current project',
    });
  }
  const open = (id: string) => navigate(`/requirements?case=${encodeURIComponent(id)}&view=needs`);
  return <FormField label="Project" description="Switch between your saved projects. Unsaved edits are protected when you switch.">
    <div className="eddie-input-action">
      <Select
        ariaLabel="Switch project"
        filteringType="auto"
        options={options}
        selectedOption={options.find((o) => o.value === form.caseId) ?? null}
        onChange={({ detail }) => {
          if (detail.selectedOption.value && detail.selectedOption.value !== form.caseId) open(detail.selectedOption.value);
        }}
        empty="No saved projects yet"
        filteringPlaceholder="Find a project"
      />
      <Button iconName="add-plus" onClick={() => open(`project-${crypto.randomUUID()}`)}>New project</Button>
    </div>
  </FormField>;
}
