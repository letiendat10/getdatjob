import type { Metadata } from "next";
import Link from "next/link";
import { getAccessHref } from "@/lib/get-access-href";

export const metadata: Metadata = {
  title: "Privacy Policy — getdatjob",
  description: "How getdatjob collects, uses, and protects your information.",
};

const LAST_UPDATED = "May 25, 2026";

export default async function PrivacyPage() {
  // Auth-aware "Get access" CTA (nav): signed-in → /me/chat, signed-out → /auth/signin.
  const getAccess = await getAccessHref();
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        fontFamily: "var(--font-geist-sans), sans-serif",
        color: "var(--ink)",
      }}
    >
      {/* Nav */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 30,
          background: "rgba(244,240,232,.85)",
          backdropFilter: "saturate(140%) blur(10px)",
          borderBottom: "1px solid rgba(0,0,0,.04)",
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: "0 auto",
            padding: "0 28px",
            width: "100%",
            height: 62,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Link
            href="/"
            style={{
              fontFamily: "var(--font-geist-sans), sans-serif",
              fontWeight: 600,
              fontSize: 17,
              letterSpacing: "-0.015em",
              color: "var(--ink)",
            }}
          >
            getdatjob
          </Link>
          <Link
            href={getAccess}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 16px",
              borderRadius: 999,
              fontSize: 14,
              fontWeight: 500,
              background: "var(--ink)",
              color: "#F4F0E8",
              border: "1px solid transparent",
            }}
          >
            Get access
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" />
            </svg>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main
        style={{
          maxWidth: 760,
          margin: "0 auto",
          padding: "56px 24px 96px",
        }}
      >
        <p style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 12 }}>
          Last updated: {LAST_UPDATED}
        </p>
        <h1
          style={{
            fontFamily: "var(--font-instrument-serif), serif",
            fontSize: "clamp(32px, 6vw, 48px)",
            fontWeight: 400,
            letterSpacing: "-0.01em",
            color: "var(--ink)",
            margin: "0 0 48px",
            lineHeight: 1.15,
          }}
        >
          Privacy Policy
        </h1>

        <Section title="1. Introduction">
          <p>
            getdatjob (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;) is a job board built for working visa holders in the United States. We take your privacy seriously. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use getdatjob.com and any related services.
          </p>
          <p>
            By accessing or using getdatjob, you agree to the terms of this Privacy Policy. If you do not agree, please do not use our services.
          </p>
        </Section>

        <Section title="2. Information We Collect">
          <SubHeading>2.1 Information You Provide</SubHeading>
          <p>When you create an account or use our services, we may collect:</p>
          <ul>
            <li>Account information such as your name and email address</li>
            <li>LinkedIn profile data when you sign in with LinkedIn (name, email, profile photo, and public profile URL)</li>
            <li>Job search preferences and saved searches</li>
            <li>Communication data from support requests or feedback you submit</li>
          </ul>

          <SubHeading>2.2 Information Collected Automatically</SubHeading>
          <p>When you use getdatjob, we automatically collect certain data, including:</p>
          <ul>
            <li>Usage data: pages visited, search queries, jobs viewed, and time spent on the platform</li>
            <li>Device and browser information: browser type, operating system, and screen resolution</li>
            <li>IP address and approximate location data</li>
            <li>Cookies and similar tracking technologies (see Section 8)</li>
          </ul>

          <SubHeading>2.3 Job Search Data</SubHeading>
          <p>
            We collect your visa type preferences, job search filters, and saved jobs to deliver personalized results. You retain ownership of the preferences and settings you configure. We use this data solely to improve relevance and your experience on getdatjob.
          </p>
        </Section>

        <Section title="3. How We Use Your Information">
          <p>We use the information we collect to:</p>
          <ul>
            <li>Provide, maintain, and improve the getdatjob platform</li>
            <li>Personalize your job search results and recommendations</li>
            <li>Send transactional emails such as job alerts or account notifications</li>
            <li>Respond to your questions and support requests</li>
            <li>Analyze usage patterns to improve the product</li>
            <li>Detect and prevent fraud, abuse, or security incidents</li>
            <li>Comply with applicable legal obligations</li>
          </ul>
          <p>
            We will not use your information for purposes materially different from those described above without your prior consent.
          </p>
        </Section>

        <Section title="4. Information Sharing">
          <p>
            <strong>We do not sell your personal information.</strong> We may share data with third parties only in the following limited circumstances:
          </p>
          <ul>
            <li>
              <strong>Service providers:</strong> We share data with trusted vendors who help us operate the platform (e.g., Supabase for database hosting, Vercel for hosting, analytics providers). These vendors are contractually bound to process data only as directed by us.
            </li>
            <li>
              <strong>Legal requirements:</strong> We may disclose information if required by law, court order, or to protect the rights and safety of getdatjob or others.
            </li>
            <li>
              <strong>Business transfers:</strong> If getdatjob is acquired or merges with another company, your information may be transferred as part of that transaction. We will notify you before your data becomes subject to a different privacy policy.
            </li>
            <li>
              <strong>With your consent:</strong> We may share information for any other purpose with your explicit consent.
            </li>
          </ul>
        </Section>

        <Section title="5. Data Security">
          <p>
            We implement industry-standard security measures to protect your data, including:
          </p>
          <ul>
            <li>HTTPS encryption for all data in transit</li>
            <li>Secure cloud hosting via Supabase and Vercel with access controls</li>
            <li>Regular security monitoring and audits</li>
            <li>Minimal data retention — we only keep what we need</li>
          </ul>
          <p>
            No method of transmission over the internet or electronic storage is 100% secure. While we strive to use commercially acceptable means to protect your data, we cannot guarantee its absolute security.
          </p>
        </Section>

        <Section title="6. Data Retention">
          <p>
            We retain your personal information for as long as your account is active or as needed to provide our services. If you delete your account, we will delete or anonymize your data within 30 days, except where we are required to retain it by law.
          </p>
          <p>
            To request deletion of your account and associated data, contact us at{" "}
            <a href="mailto:le.tiendat10@gmail.com" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              le.tiendat10@gmail.com
            </a>
            .
          </p>
        </Section>

        <Section title="7. Your Rights">
          <p>
            Depending on your location, you may have the following rights regarding your personal data:
          </p>
          <ul>
            <li><strong>Access:</strong> Request a copy of the personal data we hold about you.</li>
            <li><strong>Correction:</strong> Ask us to correct inaccurate or incomplete data.</li>
            <li><strong>Deletion:</strong> Request that we delete your personal data.</li>
            <li><strong>Restriction:</strong> Ask us to stop processing your data in certain ways.</li>
            <li><strong>Portability:</strong> Receive your data in a structured, machine-readable format.</li>
            <li><strong>Objection:</strong> Object to processing based on our legitimate interests.</li>
          </ul>
          <p>
            To exercise any of these rights, email us at{" "}
            <a href="mailto:le.tiendat10@gmail.com" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              le.tiendat10@gmail.com
            </a>
            . We will respond within 30 days.
          </p>
        </Section>

        <Section title="8. Cookies and Tracking">
          <p>
            We use cookies and similar technologies to enhance your experience and understand how getdatjob is used. These include:
          </p>
          <ul>
            <li><strong>Essential cookies:</strong> Required for the platform to function (e.g., session authentication).</li>
            <li><strong>Analytics cookies:</strong> Help us understand usage patterns so we can improve the product.</li>
            <li><strong>Preference cookies:</strong> Remember your search filters and settings between visits.</li>
          </ul>
          <p>
            You can control cookie preferences through your browser settings. Disabling cookies may affect certain features of the platform.
          </p>
        </Section>

        <Section title="9. International Data Transfers">
          <p>
            getdatjob is operated from the United States. If you are accessing our services from outside the US, your information may be transferred to and processed in the US or other countries where our service providers operate. By using getdatjob, you consent to such transfers.
          </p>
          <p>
            We take appropriate measures to ensure data transferred internationally is handled in accordance with applicable privacy laws.
          </p>
        </Section>

        <Section title="10. Children's Privacy">
          <p>
            getdatjob is not directed at users under the age of 13. We do not knowingly collect personal information from children under 13. If we become aware that we have inadvertently collected such information, we will take steps to delete it promptly.
          </p>
        </Section>

        <Section title="11. Third-Party Links">
          <p>
            getdatjob links to external job listings and employer websites. We are not responsible for the privacy practices or content of those third-party sites. We encourage you to review their privacy policies before providing any personal information.
          </p>
        </Section>

        <Section title="12. Changes to This Policy">
          <p>
            We may update this Privacy Policy from time to time. When we do, we will revise the &ldquo;Last updated&rdquo; date at the top of this page and, for material changes, notify you by email or a prominent notice on the platform.
          </p>
          <p>
            Continued use of getdatjob after changes become effective constitutes acceptance of the revised policy.
          </p>
        </Section>

        <Section title="13. Contact Us" last>
          <p>
            If you have questions, concerns, or requests about this Privacy Policy or how we handle your data, please contact us:
          </p>
          <p>
            <strong>getdatjob, Inc.</strong>
            <br />
            <a href="mailto:le.tiendat10@gmail.com" style={{ color: "var(--accent)", textDecoration: "underline" }}>
              le.tiendat10@gmail.com
            </a>
          </p>
        </Section>
      </main>

      {/* Minimal footer */}
      <footer
        style={{
          borderTop: "1px solid var(--line)",
          padding: "24px",
          textAlign: "center",
          fontSize: 13,
          color: "var(--ink-3)",
        }}
      >
        <p style={{ margin: 0 }}>
          © 2026 getdatjob, Inc.{" "}
          <Link href="/" style={{ color: "var(--ink-3)", textDecoration: "underline" }}>
            Home
          </Link>
        </p>
      </footer>
    </div>
  );
}

function Section({
  title,
  children,
  last,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section
      style={{
        borderTop: "1px solid var(--line)",
        paddingTop: 32,
        marginBottom: last ? 0 : 32,
      }}
    >
      <h2
        style={{
          fontSize: 17,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "var(--ink)",
          margin: "0 0 16px",
        }}
      >
        {title}
      </h2>
      <div
        style={{
          fontSize: 15,
          lineHeight: 1.75,
          color: "var(--ink-2)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {children}
      </div>
    </section>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontWeight: 600,
        fontSize: 14,
        color: "var(--ink)",
        margin: "4px 0 -4px",
        letterSpacing: "-0.01em",
      }}
    >
      {children}
    </p>
  );
}
