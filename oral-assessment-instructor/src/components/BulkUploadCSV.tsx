import { Fragment, useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { useNavigate } from 'react-router-dom';
import Papa from 'papaparse';
import { apiService } from '../services/api';
import { useAssessmentStore } from '../store/assessmentStore';
import type { UploadedStudent } from '../../../shared/types/assessment';

interface ParsedStudent {
  name: string;
  email: string;
  studentId: string;
  code: string;
  assignmentFile?: string;
}

interface BulkUploadCSVProps {
  assessmentId: string;
  onUploadSuccess?: () => void;
}

export default function BulkUploadCSV({ assessmentId, onUploadSuccess }: BulkUploadCSVProps) {
  const navigate = useNavigate();
  const { setLoading, setError } = useAssessmentStore();

  const [parsedStudents, setParsedStudents] = useState<ParsedStudent[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  const handleDownloadTemplate = () => {
    const csv = [
      'name,email,studentId,code',
      'Jane Smith,jane@university.edu,s12345,"def factorial(n): return 1 if n <= 1 else n * factorial(n-1)"',
      'John Doe,john@university.edu,s12346,"def factorial(n):\\n    if n <= 1:\\n        return 1\\n    return n * factorial(n-1)"',
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'students_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseCSV = (csvText: string): Promise<ParsedStudent[]> => {
    return new Promise<ParsedStudent[]>((resolve, reject) => {
      Papa.parse<Record<string, string>>(csvText, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          try {
            if (results.errors.length > 0) {
              reject(new Error(`CSV parse errors: ${results.errors.map(e => e.message).join(', ')}`));
              return;
            }

            if (results.data.length === 0) {
              reject(new Error('CSV file is empty'));
              return;
            }

            const normalizedData = results.data.map(row => {
              const normalizedRow: Record<string, string> = {};
              Object.keys(row).forEach(key => {
                normalizedRow[key.toLowerCase().trim().replace(/[_\- ]/g, '')] = row[key];
              });
              return normalizedRow;
            });

            const requiredHeaders = ['name', 'email', 'studentid', 'code'];
            const firstRow = normalizedData[0];
            const headers = Object.keys(firstRow);
            const missingHeaders = requiredHeaders.filter(h => !headers.includes(h));

            if (missingHeaders.length > 0) {
              reject(new Error(`Missing required columns: ${missingHeaders.join(', ')}`));
              return;
            }

            const seenIds = new Set<string>();
            const students: ParsedStudent[] = [];
            const validationErrors: string[] = [];

            for (let index = 0; index < normalizedData.length; index++) {
              const row = normalizedData[index];

              const name = row.name?.trim() || '';
              const email = row.email?.trim() || '';
              const studentId = row.studentid?.trim() || '';

              if (!studentId) {
                validationErrors.push(`Row ${index + 2}: Missing studentId`);
              }
              if (!name) {
                validationErrors.push(`Row ${index + 2}: Missing name`);
              }
              if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
                validationErrors.push(`Row ${index + 2}: Invalid email address "${email}"`);
              }
              if (studentId && seenIds.has(studentId)) {
                validationErrors.push(`Row ${index + 2}: Duplicate studentId "${studentId}"`);
              }
              if (studentId) seenIds.add(studentId);

              if (validationErrors.length === 0) {
                students.push({
                  name,
                  email,
                  studentId,
                  code: row.code || '',
                  assignmentFile: row.assignmentfile?.trim(),
                });
              }
            }

            if (validationErrors.length > 0) {
              reject(new Error(validationErrors.join('\n')));
              return;
            }

            resolve(students);
          } catch (err) {
            reject(err);
          }
        },
        error: (error: Error) => {
          reject(new Error(`Failed to parse CSV: ${error.message}`));
        },
      });
    });
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setParseError(null);

    if (acceptedFiles.length === 0) return;

    if (acceptedFiles.length > 1) {
      setParseError('Multiple files detected. Only the first file will be used.');
    }

    const file = acceptedFiles[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const csvText = e.target?.result as string;
        const students = await parseCSV(csvText);
        setParsedStudents(students);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : 'Failed to parse CSV file');
      }
    };

    reader.onerror = () => {
      setParseError('Failed to read file');
    };

    reader.readAsText(file);
  }, []);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.ms-excel': ['.csv'],
    },
    multiple: false,
  });

  const handleUpload = async () => {
    if (!assessmentId || parsedStudents.length === 0) return;

    try {
      setIsUploading(true);
      setLoading(true);
      setError(null);

      const uploadData: UploadedStudent[] = parsedStudents.map((s) => ({
        name: s.name,
        email: s.email,
        studentId: s.studentId,
        code: s.code,
        assignmentFile: s.assignmentFile,
      }));

      await apiService.uploadStudents(assessmentId, uploadData);

      onUploadSuccess?.();
      navigate(`/assessments/${assessmentId}/generate`, { state: { uploaded: true } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload students');
    } finally {
      setIsUploading(false);
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="bg-paper border border-hairline rounded-xl p-6">
        <h3 className="font-serif text-lg font-semibold text-ink mb-3">CSV Format Requirements</h3>
        <p className="text-slate mb-4">
          Your CSV file must include the following columns (case-insensitive):
        </p>
        <ul className="space-y-2 text-sm text-slate">
          <li className="flex items-start">
            <span aria-hidden="true" className="text-accent mr-2">•</span>
            <span><strong className="text-ink">name</strong> - Student's full name</span>
          </li>
          <li className="flex items-start">
            <span aria-hidden="true" className="text-accent mr-2">•</span>
            <span><strong className="text-ink">email</strong> - Student's email address</span>
          </li>
          <li className="flex items-start">
            <span aria-hidden="true" className="text-accent mr-2">•</span>
            <span><strong className="text-ink">studentId</strong> - Unique student identifier</span>
          </li>
          <li className="flex items-start">
            <span aria-hidden="true" className="text-accent mr-2">•</span>
            <span><strong className="text-ink">code</strong> - Student's submitted code (single line or escaped)</span>
          </li>
          <li className="flex items-start">
            <span aria-hidden="true" className="text-slate mr-2">•</span>
            <span><strong>assignmentFile</strong> - (Optional) Path to assignment file</span>
          </li>
        </ul>

        <div className="mt-4 p-3 bg-ink/5 rounded-xl border border-hairline">
          <p className="text-xs text-slate font-mono mb-2">Example CSV:</p>
          <pre className="text-xs text-slate font-mono overflow-x-auto">
{`name,email,studentId,code
John Doe,john@example.com,12345,"def factorial(n): return 1 if n <= 1 else n * factorial(n-1)"
Jane Smith,jane@example.com,12346,"def factorial(n):\\n    if n <= 1:\\n        return 1\\n    return n * factorial(n-1)"`}
          </pre>
        </div>
        <button
          type="button"
          onClick={handleDownloadTemplate}
          className="mt-4 rounded text-sm text-accent hover:text-accent-hover underline transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          Download template CSV
        </button>
      </div>

      {/* react-dropzone wires tabIndex + Enter/Space; role/aria-label expose it to AT. */}
      <div
        {...getRootProps()}
        role="button"
        aria-label="Upload a student CSV file. Drag and drop a .csv file here, or activate to browse."
        className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${
          isDragReject
            ? 'border-danger bg-danger/10'
            : isDragActive
            ? 'border-accent bg-accent/10'
            : 'border-hairline bg-paper hover:border-accent hover:bg-ink/5'
        }`}
      >
        <input {...getInputProps()} />
        <svg
          className={`mx-auto h-12 w-12 mb-4 ${
            isDragReject ? 'text-danger' : isDragActive ? 'text-accent' : 'text-slate'
          }`}
          stroke="currentColor"
          fill="none"
          viewBox="0 0 48 48"
          aria-hidden="true"
        >
          <path
            d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {isDragReject ? (
          <p className="text-danger font-medium" role="status" aria-live="polite">
            That file type isn't accepted — drop a .csv file
          </p>
        ) : isDragActive ? (
          <p className="text-ink font-medium" role="status" aria-live="polite">
            Drop the CSV file here
          </p>
        ) : (
          <>
            <p className="text-ink font-medium mb-1">
              Drag and drop CSV file here, or click to browse
            </p>
            <p className="text-sm text-slate">Only .csv files are accepted</p>
          </>
        )}
      </div>

      {/* Not <ErrorMessage>: row errors are newline-joined and listed one per line. */}
      {parseError && (
        <div className="bg-danger/10 border border-danger/30 rounded-xl p-4" role="alert">
          <div className="flex items-start">
            <svg
              className="h-5 w-5 text-danger mr-3 mt-0.5 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div>
              <h4 className="text-sm font-medium text-danger mb-1">CSV Parse Error</h4>
              {parseError.includes('\n') ? (
                <ul className="text-sm text-danger list-disc list-inside space-y-1">
                  {parseError.split('\n').map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-danger">{parseError}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {parsedStudents.length > 0 && (
        <div className="bg-paper border border-hairline rounded-xl overflow-hidden">
          <div className="p-4 border-b border-hairline">
            <h3 className="font-serif text-lg font-semibold text-ink">
              Preview (<span className="tabular-nums">{parsedStudents.length}</span> students)
            </h3>
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full">
              <thead className="bg-ink/5">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">
                    Email
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">
                    Student ID
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate uppercase tracking-wider">
                    Code
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {/* Fragment carries the key: each row may have an expanded-code row. */}
                {parsedStudents.map((student, index) => (
                  <Fragment key={index}>
                    <tr className="hover:bg-ink/5">
                      <td className="px-4 py-3 text-sm text-ink">{student.name}</td>
                      <td className="px-4 py-3 text-sm text-slate">{student.email}</td>
                      <td className="px-4 py-3 text-sm text-slate tabular-nums">{student.studentId}</td>
                      <td className="px-4 py-3 text-sm text-slate">
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums">{student.code.length} chars</span>
                          <button
                            type="button"
                            onClick={() => setExpandedRow(expandedRow === index ? null : index)}
                            aria-expanded={expandedRow === index}
                            aria-controls={`csv-preview-code-${index}`}
                            aria-label={
                              expandedRow === index
                                ? `Hide submitted code for ${student.name}`
                                : `View submitted code for ${student.name}`
                            }
                            className="rounded text-xs text-accent hover:text-accent-hover underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
                          >
                            {expandedRow === index ? 'hide' : 'view'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedRow === index && (
                      <tr id={`csv-preview-code-${index}`}>
                        <td colSpan={4} className="px-4 py-2 bg-ink/5">
                          <pre className="text-xs text-slate font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{student.code}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {parsedStudents.length > 0 && (
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleUpload}
            disabled={isUploading}
            aria-busy={isUploading}
            className="bg-accent text-white px-6 py-2.5 rounded-xl font-medium hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-paper disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isUploading ? (
              'Uploading...'
            ) : (
              <>
                Upload <span className="tabular-nums">{parsedStudents.length}</span> Students
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setParsedStudents([])}
            disabled={isUploading}
            className="bg-ink/5 text-ink px-6 py-2.5 rounded-xl font-medium hover:bg-ink/10 transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-paper disabled:opacity-50"
          >
            Clear
          </button>
          {isUploading && (
            <p role="status" aria-live="polite" className="text-sm text-slate">
              Uploading <span className="tabular-nums">{parsedStudents.length}</span> students…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
