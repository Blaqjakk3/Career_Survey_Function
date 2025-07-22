import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize client
const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Define which attributes exist in the talents collection
const VALID_TALENT_ATTRIBUTES = [
    'fullname', 'email', 'avatar', 'careerStage', 'dateofBirth', 'talentId',
    'selectedPath', 'degrees', 'certifications', 'skills', 'interests',
    'currentPath', 'testTaken', 'interestedFields', 'savedPaths',
    'currentSeniorityLevel', 'savedJobs'
];

const ARRAY_ATTRIBUTES = [
    'degrees', 'certifications', 'skills', 'interests', 
    'interestedFields', 'savedPaths', 'savedJobs'
];

// Set execution timeout to 25 seconds to avoid 30s limit
const EXECUTION_TIMEOUT = 25000;
const AI_TIMEOUT = 15000; // 15 seconds for AI analysis

export default async ({ req, res, log, error }) => {
    const startTime = Date.now();
    
    try {
        log('Starting optimized AI career matching...');
        
        const { talentId, surveyResponses } = JSON.parse(req.body);

        if (!talentId || !surveyResponses) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters: talentId and surveyResponses' 
            }, 400);
        }

        // Set up timeout for entire execution
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Function execution timeout')), EXECUTION_TIMEOUT);
        });

        const executionPromise = executeCareerMatching(talentId, surveyResponses, log, error);
        
        // Race between execution and timeout
        const result = await Promise.race([executionPromise, timeoutPromise]);
        
        const executionTime = Date.now() - startTime;
        log(`Total execution time: ${executionTime}ms`);
        
        return res.json(result);

    } catch (err) {
        const executionTime = Date.now() - startTime;
        error(`Career matching failed after ${executionTime}ms:`, err);
        
        return res.json({ 
            success: false, 
            error: err.message || 'Failed to generate career matches',
            executionTime: executionTime,
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }, 500);
    }
};

async function executeCareerMatching(talentId, surveyResponses, log, error) {
    // Fetch talent and career paths in parallel
    const [talentQuery, careerPathsQuery] = await Promise.all([
        databases.listDocuments('career4me', 'talents', [Query.equal('talentId', talentId)]),
        databases.listDocuments('career4me', 'careerPaths', [Query.limit(50)]) // Reduced from 100
    ]);

    if (careerPathsQuery.documents.length === 0) {
        throw new Error('No career paths available');
    }

    if (talentQuery.documents.length === 0) {
        throw new Error('Talent not found');
    }

    const talent = talentQuery.documents[0];

    // Update talent document (non-blocking)
    const validUpdates = filterValidAttributes(surveyResponses);
    validUpdates.testTaken = true;
    
    // Don't await this - let it run in background
    databases.updateDocument('career4me', 'talents', talent.$id, validUpdates)
        .catch(err => log(`Warning: Failed to update talent: ${err.message}`));

    // Get current career path if available (with timeout)
    let currentCareerPath = null;
    if (surveyResponses.currentPath) {
        try {
            currentCareerPath = await Promise.race([
                databases.getDocument('career4me', 'careerPaths', surveyResponses.currentPath),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
            ]);
        } catch (err) {
            log(`Warning: Could not fetch current career path: ${err.message}`);
        }
    }

    // Generate matches with timeout
    const matches = await generateOptimizedAIMatches(
        talent, surveyResponses, careerPathsQuery.documents, currentCareerPath, log
    );

    return {
        success: true,
        matches: matches,
        totalPaths: careerPathsQuery.documents.length,
        matchedPaths: matches.length
    };
}

async function generateOptimizedAIMatches(talent, surveyResponses, careerPaths, currentCareerPath, log) {
    try {
        // Pre-filter career paths to reduce AI processing load
        const relevantPaths = preFilterCareerPaths(surveyResponses, careerPaths);
        log(`Pre-filtered to ${relevantPaths.length} relevant paths from ${careerPaths.length} total`);

        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.0-flash-exp', // Faster model
            generationConfig: {
                maxOutputTokens: 3072, // Increased for more matches
                temperature: 0.4, // Slightly more creative for diverse matches
            }
        });

        const contextPrompt = buildOptimizedContextPrompt(talent, surveyResponses, currentCareerPath);
        const careerPathsSummary = createEnhancedPathSummary(relevantPaths);

        const analysisPrompt = `${contextPrompt}

CAREER PATHS AVAILABLE (${relevantPaths.length}):
${careerPathsSummary}

TASK: Analyze and rank ALL suitable career paths. Return your TOP 8 BEST MATCHES as JSON.

SCORING CRITERIA:
- Skills Alignment (35%): Current skills + learning interest + transferable skills
- Interest Match (25%): Personal interests + field preferences
- Education Fit (20%): Educational background relevance
- Career Stage Fit (10%): Appropriate for ${talent.careerStage} level
- Growth Potential (10%): Future opportunities and development path

MATCHING RULES:
1. Score each path 0-100 based on above criteria
2. Include mix of: perfect fits (90-100%), strong matches (75-89%), growth opportunities (60-74%)
3. Prioritize paths that match skills AND interests
4. Consider transferable skills and learning willingness
5. For career changers: weight interests higher than current skills

Return EXACTLY this JSON structure:
{
  "matches": [
    {
      "careerPathId": "path_id_here",
      "matchScore": 92,
      "reasoning": "Concise explanation of why this is a strong match focusing on top 2-3 alignment factors",
      "strengths": ["2-3 specific strengths that make this person suitable"],
      "developmentAreas": ["2-3 key areas to focus development on"],
      "recommendations": ["3-4 specific actionable steps to pursue this path"]
    }
  ]
}

Ensure diversity in match types and industries. Include at least one stretch/growth opportunity match.`;

        // AI analysis with timeout
        const aiPromise = model.generateContent(analysisPrompt);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('AI timeout')), AI_TIMEOUT)
        );

        const result = await Promise.race([aiPromise, timeoutPromise]);
        const aiResponse = result.response.text();
        
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Invalid AI response format');
        }
        
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        // Enrich with full career path data and validate
        const enrichedMatches = analysisResult.matches
            .map(match => {
                const careerPath = careerPaths.find(path => path.$id === match.careerPathId);
                if (!careerPath) return null;
                
                return {
                    careerPath,
                    matchScore: Math.min(Math.max(match.matchScore, 0), 100), // Ensure score is 0-100
                    reasoning: match.reasoning || `Good fit based on your ${talent.careerStage} profile`,
                    strengths: Array.isArray(match.strengths) ? match.strengths : ['Strong foundation for growth'],
                    developmentAreas: Array.isArray(match.developmentAreas) ? match.developmentAreas : ['Industry knowledge', 'Specialized skills'],
                    recommendations: Array.isArray(match.recommendations) ? match.recommendations : ['Take relevant courses', 'Build portfolio projects', 'Network with professionals']
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.matchScore - a.matchScore); // Sort by score descending

        log(`AI generated ${enrichedMatches.length} matches`);
        
        // Return top 8 matches, but ensure we have at least 5
        const finalMatches = enrichedMatches.slice(0, 8);
        
        if (finalMatches.length < 5) {
            log(`Only ${finalMatches.length} AI matches, supplementing with fallback`);
            const fallbackMatches = generateFastFallbackMatches(surveyResponses, careerPaths, talent.careerStage);
            
            // Add fallback matches that aren't already included
            const existingIds = new Set(finalMatches.map(m => m.careerPath.$id));
            const additionalMatches = fallbackMatches.filter(m => !existingIds.has(m.careerPath.$id));
            
            finalMatches.push(...additionalMatches.slice(0, 5 - finalMatches.length));
        }

        return finalMatches;

    } catch (err) {
        log(`AI analysis failed (${err.message}), using enhanced fallback`);
        return generateEnhancedFallbackMatches(surveyResponses, careerPaths, talent);
    }
}

function preFilterCareerPaths(surveyResponses, careerPaths) {
    // Enhanced filtering to be more inclusive while still reducing load
    const interestedFields = surveyResponses.interestedFields || [];
    const currentSkills = surveyResponses.currentSkills || [];
    const interests = surveyResponses.interests || [];
    
    if (interestedFields.length === 0 && currentSkills.length === 0 && interests.length === 0) {
        return careerPaths.slice(0, 30); // Return more paths if no specific criteria
    }

    const filtered = careerPaths.filter(path => {
        let score = 0;
        
        // Field match (high weight)
        if (interestedFields.includes(path.industry)) score += 3;
        
        // Skill overlap (medium-high weight)
        const pathSkills = path.requiredSkills || [];
        const skillMatches = currentSkills.filter(skill => 
            pathSkills.some(pathSkill => 
                pathSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(pathSkill.toLowerCase())
            )
        ).length;
        score += skillMatches;
        
        // Interest alignment (medium weight)
        const pathInterests = path.requiredInterests || [];
        const interestMatches = interests.filter(interest =>
            pathInterests.some(pathInterest =>
                pathInterest.toLowerCase().includes(interest.toLowerCase()) ||
                interest.toLowerCase().includes(pathInterest.toLowerCase())
            )
        ).length;
        score += interestMatches * 0.5;
        
        // Include if any criteria match or if it's a broad match
        return score > 0;
    });

    // If we filtered too aggressively, include more paths
    if (filtered.length < 15) {
        const remaining = careerPaths.filter(path => !filtered.includes(path));
        filtered.push(...remaining.slice(0, 15 - filtered.length));
    }

    return filtered.slice(0, 35); // Increased limit for more options
}

function createEnhancedPathSummary(paths) {
    return paths.map(path => {
        const skills = (path.requiredSkills || []).slice(0, 4).join(',');
        const interests = (path.requiredInterests || []).slice(0, 3).join(',');
        return `${path.$id}: "${path.title}" | Industry: ${path.industry} | Skills: ${skills} | Interests: ${interests} | Level: ${path.level || 'All'}`;
    }).join('\n');
}

function buildOptimizedContextPrompt(talent, surveyResponses, currentCareerPath) {
    const age = calculateAge(talent.dateofBirth);
    
    let prompt = `CANDIDATE PROFILE:
Career Stage: ${talent.careerStage}
Age: ${age}
Education: ${surveyResponses.educationLevel || 'Not specified'}`;
    
    if (surveyResponses.degreeProgram) {
        prompt += ` (${surveyResponses.degreeProgram})`;
    }
    
    prompt += `

SKILLS & INTERESTS:
Current Skills: ${(surveyResponses.currentSkills || ['None listed']).join(', ')}
Eager to Learn: ${(surveyResponses.skillsToLearn || ['Open to learning']).join(', ')}
Personal Interests: ${(surveyResponses.interests || ['Various']).join(', ')}
Interested Fields: ${(surveyResponses.interestedFields || ['Exploring options']).join(', ')}`;

    // Add work preferences
    if (surveyResponses.workEnvironmentPreference) {
        prompt += `
Work Environment Preference: ${surveyResponses.workEnvironmentPreference}`;
    }

    // Add current experience context
    if (currentCareerPath) {
        prompt += `

CURRENT SITUATION:
Current Path: ${currentCareerPath.title} in ${currentCareerPath.industry}
Experience: ${surveyResponses.yearsExperience || 'Not specified'} years
Level: ${surveyResponses.currentSeniorityLevel || 'Not specified'}`;
        
        if (surveyResponses.reasonForChange) {
            prompt += `
Reason for Change: ${surveyResponses.reasonForChange}`;
        }
    }

    // Add career goals if available
    if (surveyResponses.careerGoals) {
        prompt += `
Career Goals: ${surveyResponses.careerGoals}`;
    }

    return prompt;
}

function generateEnhancedFallbackMatches(surveyResponses, careerPaths, talent) {
    const currentSkills = surveyResponses.currentSkills || [];
    const interests = surveyResponses.interests || [];
    const fields = surveyResponses.interestedFields || [];
    const skillsToLearn = surveyResponses.skillsToLearn || [];
    
    const scoredPaths = careerPaths.map(path => {
        let score = 0;
        let reasoning = [];
        
        // Enhanced scoring algorithm
        const skillMatches = (path.requiredSkills || [])
            .filter(skill => currentSkills.some(userSkill => 
                userSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(userSkill.toLowerCase())
            )).length;
        score += skillMatches * 25;
        if (skillMatches > 0) reasoning.push(`${skillMatches} skill alignment${skillMatches > 1 ? 's' : ''}`);
        
        const learningMatches = (path.requiredSkills || [])
            .filter(skill => skillsToLearn.some(learnSkill =>
                learnSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(learnSkill.toLowerCase())
            )).length;
        score += learningMatches * 15;
        if (learningMatches > 0) reasoning.push(`interested in learning ${learningMatches} relevant skill${learningMatches > 1 ? 's' : ''}`);
        
        const interestMatches = (path.requiredInterests || [])
            .filter(interest => interests.some(userInterest =>
                userInterest.toLowerCase().includes(interest.toLowerCase()) ||
                interest.toLowerCase().includes(userInterest.toLowerCase())
            )).length;
        score += interestMatches * 20;
        if (interestMatches > 0) reasoning.push(`${interestMatches} interest match${interestMatches > 1 ? 'es' : ''}`);
        
        if (fields.includes(path.industry)) {
            score += 30;
            reasoning.push(`strong interest in ${path.industry}`);
        }
        
        // Career stage bonus
        if (path.level && talent.careerStage) {
            if ((talent.careerStage === 'Pathfinder' && path.level === 'Entry') ||
                (talent.careerStage === 'Trailblazer' && ['Entry', 'Mid'].includes(path.level)) ||
                (talent.careerStage === 'Horizon Changer' && ['Mid', 'Senior'].includes(path.level))) {
                score += 10;
                reasoning.push(`appropriate for ${talent.careerStage} level`);
            }
        }
        
        // Add some randomization for variety
        score += Math.random() * 8;
        
        return {
            careerPath: path,
            matchScore: Math.min(Math.round(score), 95), // Cap at 95 for fallback
            reasoning: reasoning.length > 0 ? reasoning.join(', ') : `Potential fit for your ${talent.careerStage} profile`,
            strengths: currentSkills.slice(0, 2).map(s => `Experience with ${s}`) || ['Foundation for growth'],
            developmentAreas: ['Industry-specific knowledge', 'Advanced skill development'],
            recommendations: [
                'Research the field thoroughly',
                'Take introductory courses',
                'Connect with professionals in the industry',
                'Start building relevant projects'
            ]
        };
    });
    
    return scoredPaths
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 8);
}

function generateFastFallbackMatches(surveyResponses, careerPaths, careerStage) {
    // Keep original fast fallback for emergency use
    const currentSkills = surveyResponses.currentSkills || [];
    const interests = surveyResponses.interests || [];
    const fields = surveyResponses.interestedFields || [];
    
    const scoredPaths = careerPaths.map(path => {
        let score = 0;
        
        const skillMatches = (path.requiredSkills || [])
            .filter(skill => currentSkills.includes(skill)).length;
        score += skillMatches * 20;
        
        const interestMatches = (path.requiredInterests || [])
            .filter(interest => interests.includes(interest)).length;
        score += interestMatches * 15;
        
        if (fields.includes(path.industry)) score += 30;
        
        score += Math.random() * 10;
        
        return {
            careerPath: path,
            matchScore: Math.min(Math.round(score), 100),
            reasoning: `${skillMatches} skill matches and ${interestMatches} interest alignments`,
            strengths: currentSkills.slice(0, 2).map(s => `Strong in ${s}`),
            developmentAreas: ['Industry knowledge', 'Specialized skills'],
            recommendations: ['Take courses', 'Build projects', 'Network']
        };
    });
    
    return scoredPaths
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 6);
}

function filterValidAttributes(surveyResponses) {
    const validUpdates = {};
    
    for (const [key, value] of Object.entries(surveyResponses)) {
        if (VALID_TALENT_ATTRIBUTES.includes(key)) {
            if (ARRAY_ATTRIBUTES.includes(key)) {
                validUpdates[key] = Array.isArray(value) ? value : 
                    (value ? [value] : []);
            } else {
                validUpdates[key] = value;
            }
        }
    }
    
    return validUpdates;
}

function calculateAge(dateOfBirth) {
    if (!dateOfBirth) return '?';
    
    const birth = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
    }
    
    return age;
}