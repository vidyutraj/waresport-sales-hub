'use client';

import { saveResourceAction } from '@/app/admin/resources/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui';

export function ResourceForm() {
  return (
    <ActionForm action={saveResourceAction}>
      {(state) => (
        <>
          <Field label="Title" htmlFor="r-title" required error={state.fieldErrors.title}>
            <Input id="r-title" name="title" required maxLength={200} />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Category" htmlFor="r-category" required>
              <Select id="r-category" name="category" defaultValue="email_script">
                <option value="email_script">Email script</option>
                <option value="linkedin_script">LinkedIn script</option>
                <option value="personalization">Personalization guidance</option>
                <option value="training">Training</option>
                <option value="program_doc">Program document</option>
                <option value="platform">Platform</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label="Audience" htmlFor="r-audience" required>
              <Select id="r-audience" name="audience" defaultValue="all">
                <option value="all">Everyone</option>
                <option value="interns">Interns</option>
                <option value="admins">Admins only</option>
              </Select>
            </Field>
          </div>

          <Field label="Summary" htmlFor="r-summary" error={state.fieldErrors.summary}>
            <Input id="r-summary" name="summary" maxLength={400} />
          </Field>

          <Field
            label="Body"
            htmlFor="r-body"
            hint="The script or guidance itself."
            error={state.fieldErrors.bodyMarkdown}
          >
            <Textarea id="r-body" name="bodyMarkdown" rows={5} maxLength={20000} />
          </Field>

          <Field label="Link" htmlFor="r-link" error={state.fieldErrors.linkUrl}>
            <Input id="r-link" name="linkUrl" inputMode="url" placeholder="https://…" />
          </Field>

          <Field
            label="Attachment"
            htmlFor="r-file"
            hint="Stored privately and served only to signed-in users who may see this resource."
            error={state.fieldErrors.file}
          >
            <input
              id="r-file"
              name="file"
              type="file"
              accept=".pdf,.txt,.md,.csv,.docx,.pptx"
              className="block w-full text-[13px] text-ink-700 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-900 file:px-3 file:py-2 file:text-[13px] file:font-semibold file:text-white"
            />
          </Field>

          <Checkbox
            id="r-starter"
            name="isStarterExample"
            label="Label this as an editable starter example"
            hint="Use this for anything Waresport did not supply."
          />

          <div>
            <SubmitButton pendingLabel="Saving…">Add resource</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
