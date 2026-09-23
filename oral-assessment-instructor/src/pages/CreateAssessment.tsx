import AppShell from '../components/AppShell';
import CreateAssessmentForm from '../components/CreateAssessmentForm';
import SetupStepIndicator from '../components/SetupStepIndicator';

export default function CreateAssessment() {
  return (
    <AppShell
      breadcrumbs={[{ label: 'Assessments', to: '/assessments' }, { label: 'Create Assessment' }]}
      title="Create Assessment"
      subtitle="Define the assessment, then upload students and generate questions."
      maxWidth="narrow"
      banner={<SetupStepIndicator currentStep={1} assessmentId="" maxWidth="narrow" />}
    >
      <div className="bg-paper border border-hairline rounded-xl p-6 sm:p-8">
        <CreateAssessmentForm />
      </div>
    </AppShell>
  );
}
