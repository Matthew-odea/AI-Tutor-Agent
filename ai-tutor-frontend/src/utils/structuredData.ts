/** JSON-LD schema.org data for search results. The ai-tutor.example.com URLs are placeholders. */

export const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "AI Tutor",
  description: "An intelligent AI tutoring system for programming education",
  url: "https://ai-tutor.example.com",
  logo: "https://ai-tutor.example.com/logo.png",
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "Customer Support",
    email: "support@ai-tutor.example.com",
  },
};

export const webApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "AI Tutor",
  description:
    "An intelligent AI tutoring system that helps you learn programming through interactive conversations and code examples.",
  url: "https://ai-tutor.example.com",
  applicationCategory: "EducationalApplication",
  operatingSystem: "Web Browser",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  featureList: [
    "Interactive AI chat for programming help",
    "Integrated code editor with syntax highlighting",
    "Multiple pedagogy modes (Explanatory, Debugging, Practice)",
    "Python code execution",
    "Conversation history",
  ],
  browserRequirements: "Requires JavaScript. Requires modern web browser.",
};

export const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What is AI Tutor?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "AI Tutor is an intelligent tutoring system that helps students learn programming through interactive conversations, code examples, and personalized feedback.",
      },
    },
    {
      "@type": "Question",
      name: "What programming languages does AI Tutor support?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "AI Tutor primarily supports Python programming with an integrated code editor and execution environment.",
      },
    },
    {
      "@type": "Question",
      name: "How is my data used?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "AI Tutor is part of a research study. Your interactions may be collected and analyzed to improve the system. Participation is voluntary and data is handled according to research ethics guidelines.",
      },
    },
  ],
};

export const breadcrumbSchema = (path: string) => {
  const items: Array<{ name: string; url: string }> = [
    { name: "Home", url: "https://ai-tutor.example.com" },
  ];

  if (path === "/privacypolicy") {
    items.push({
      name: "Privacy Policy",
      url: "https://app.chat9021.org/privacypolicy",
    });
  }

  if (path === "/termsofservice") {
    items.push({
      name: "Terms of Service",
      url: "https://app.chat9021.org/termsofservice",
    });
  }

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
};

/** Returns a cleanup function that removes the injected script. */
export const injectStructuredData = (schema: object) => {
  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.text = JSON.stringify(schema);
  document.head.appendChild(script);

  return () => {
    document.head.removeChild(script);
  };
};
