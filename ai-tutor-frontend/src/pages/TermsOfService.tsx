import SEO from "../shared/SEO";

const TermsOfService = () => {
  return (
    <>
      <SEO
        title="Terms of Service"
        description="Terms of Service for Chat9021 AI Tutor, including acceptable use, account terms, disclaimers, and liability limitations."
        keywords="terms of service, terms and conditions, Chat9021, AI tutor"
        url="https://app.chat9021.org/termsofservice"
      />

      <div className="h-screen overflow-y-auto bg-gray-50">
        <div className="max-w-3xl mx-auto px-4 py-10">
          <div className="bg-white border border-gray-200 rounded-lg p-6 sm:p-8">
            <div className="mb-5">
              <a
                href="/"
                className="text-primary-600 hover:text-primary-700 font-medium"
              >
                ← Back to App
              </a>
            </div>

            <h1 className="text-2xl font-semibold text-gray-900">
              Terms of Service
            </h1>
            <p className="text-xs text-gray-500 mt-1 mb-6">
              Last updated: March 5, 2026
            </p>

            <div className="space-y-5 text-sm leading-6 text-gray-700">
              <section className="pt-2">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  1. Acceptance of Terms
                </h2>
                <p>
                  By accessing or using Chat9021, you agree to these Terms of
                  Service. If you do not agree, you should not use the service.
                </p>
              </section>

              <section className="border-t border-gray-200 pt-4">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  2. Service Description
                </h2>
                <p>
                  Chat9021 provides AI-assisted tutoring and code support tools
                  for educational use, including chat, code editing assistance,
                  and code execution features.
                </p>
              </section>

              <section className="border-t border-gray-200 pt-4">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  3. Accounts and Access
                </h2>
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    You are responsible for maintaining the security of your
                    account credentials.
                  </li>
                  <li>
                    You must provide accurate account information when creating
                    or using an account.
                  </li>
                  <li>
                    You are responsible for activity that occurs under your
                    account.
                  </li>
                </ul>
              </section>

              <section className="border-t border-gray-200 pt-4">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  4. Acceptable Use
                </h2>
                <ul className="list-disc pl-6 space-y-1">
                  <li>
                    Use the service for lawful and educational purposes only.
                  </li>
                  <li>
                    Do not attempt to abuse, disrupt, reverse engineer, or
                    compromise the platform.
                  </li>
                  <li>
                    Do not upload or submit content that is unlawful, harmful,
                    or infringes third-party rights.
                  </li>
                  <li>
                    Comply with your institution's academic integrity and
                    conduct policies.
                  </li>
                </ul>
              </section>

              <section className="border-t border-gray-200 pt-4">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  5. AI-Generated Content Disclaimer
                </h2>
                <p>
                  AI responses may be incomplete or incorrect. You are
                  responsible for reviewing outputs, validating code, and making
                  your own academic and technical decisions.
                </p>
              </section>

              <section className="border-t border-gray-200 pt-4">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  6. Intellectual Property
                </h2>
                <p>
                  You retain rights to content you submit, subject to any rights
                  needed for us to operate, maintain, and improve the service.
                  Platform materials and branding remain the property of
                  Chat9021 and its licensors.
                </p>
              </section>

              <section className="border-t border-gray-200 pt-4">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  7. Termination
                </h2>
                <p>
                  We may suspend or terminate access if these terms are
                  violated, if required for security, or to comply with legal or
                  institutional obligations.
                </p>
              </section>

              <section className="border-t border-gray-200 pt-4">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  8. Limitation of Liability
                </h2>
                <p>
                  To the extent permitted by law, the service is provided "as
                  is" without warranties. We are not liable for indirect,
                  incidental, or consequential damages arising from use of the
                  service.
                </p>
              </section>

              <section className="border-t border-gray-200 pt-4">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  9. Changes to Terms
                </h2>
                <p>
                  We may update these terms from time to time. Continued use
                  after updates means you accept the revised terms.
                </p>
              </section>

              <section className="border-t border-gray-200 pt-4">
                <h2 className="text-base font-semibold text-gray-900 mb-2">
                  10. Contact
                </h2>
                <p>
                  For questions about these terms, contact the Chat9021 team
                  through the course support channel on Ed.
                </p>
              </section>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default TermsOfService;
